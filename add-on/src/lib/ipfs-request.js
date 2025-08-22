'use strict'
/* eslint-env browser, webextensions */

import debug from 'debug'

import isFQDN from 'is-fqdn'
import isIPFS from 'is-ipfs'
import LRU from 'lru-cache'
import { recoveryPagePath } from './constants.js'
import { braveNodeType } from './ipfs-client/brave.js'
import { dropSlash, ipfsUri, pathAtHttpGateway, sameGateway } from './ipfs-path.js'
import { safeURL } from './options.js'
import { addRuleToDynamicRuleSetGenerator, isLocalHost, supportsDeclarativeNetRequest } from './redirect-handler/blockOrObserve.js'
import { RequestTracker } from './trackers/requestTracker.js'

/**
 * IPFS Companion Request Modifier
 *
 * This module provides sophisticated HTTP request interception and modification capabilities
 * for IPFS Companion. It acts as a middleware layer that intercepts web requests to:
 *
 * 1. Detect IPFS/IPNS content and redirect to appropriate gateways
 * 2. Handle DNSLink resolution for decentralized websites
 * 3. Implement request recovery mechanisms for failed IPFS requests
 * 4. Manage cross-origin request security and CORS handling
 * 5. Support protocol handlers for ipfs:// and ipns:// schemes
 *
 * Architecture Overview:
 * - Uses webRequest API for request interception across multiple stages
 * - Implements caching for performance optimization
 * - Provides fallback mechanisms for request recovery
 * - Handles browser-specific quirks and compatibility issues
 *
 * Request Processing Pipeline:
 * 1. onBeforeRequest: Initial request analysis and potential redirects
 * 2. onBeforeSendHeaders: Header modification for API compatibility
 * 3. onHeadersReceived: Late-stage redirects based on response headers
 * 4. onErrorOccurred: Network error recovery mechanisms
 * 5. onCompleted: HTTP error code recovery mechanisms
 *
 * @author IPFS Companion Team
 * @license CC0-1.0
 */

const log = debug('ipfs-companion:request')
log.error = debug('ipfs-companion:request:error')

// Configuration Constants
export const redirectOptOutHint = 'x-ipfs-companion-no-redirect'

/**
 * Network errors that can potentially be recovered by redirecting to IPFS gateways
 * Includes both Firefox-specific and Chromium-specific error codes
 */
const recoverableNetworkErrors = new Set([
  // Firefox error codes
  'NS_ERROR_UNKNOWN_HOST', // DNS resolution failure
  'NS_ERROR_NET_TIMEOUT', // Connection timeout (e.g., server offline)
  'NS_ERROR_NET_RESET', // Connection reset by server
  'NS_ERROR_NET_ON_RESOLVED', // Network connectivity issues

  // Chromium error codes
  'net::ERR_NAME_NOT_RESOLVED', // DNS resolution failure
  'net::ERR_CONNECTION_TIMED_OUT', // Connection timeout
  'net::ERR_INTERNET_DISCONNECTED' // Network connectivity issues
])

/**
 * Determines if an HTTP status code indicates a recoverable error
 * @param {number} code - HTTP status code
 * @returns {boolean} True if the error is recoverable via IPFS gateway redirect
 */
const recoverableHttpError = (code) => code && code >= 400

// Global State Management
// Tracking late redirects for edge cases such as https://github.com/ipfs-shipyard/ipfs-companion/issues/436
const onHeadersReceivedRedirect = new Set()
let addRuleToDynamicRuleSet = null

// Request tracking for analytics and debugging
const observedRequestTracker = new RequestTracker('url-observed')
const resolvedRequestTracker = new RequestTracker('url-resolved')

/**
 * Creates the main request modifier that provides event listeners for HTTP request lifecycle
 *
 * This factory function creates a comprehensive request interception system that handles:
 * - IPFS/IPNS content detection and gateway redirection
 * - DNSLink resolution for decentralized websites
 * - API request header modification for CORS compatibility
 * - Error recovery mechanisms for failed requests
 * - Protocol handler support for ipfs:// and ipns:// schemes
 *
 * Architecture Pattern: Factory Function
 * - Returns an object with webRequest API event handlers
 * - Maintains closures over provided dependencies
 * - Enables dependency injection for testability
 *
 * @param {Function} getState - Function that returns current companion state
 * @param {Object} dnslinkResolver - DNSLink resolution service
 * @param {Object} ipfsPathValidator - IPFS path validation service
 * @param {Object} runtime - Browser runtime information and APIs
 * @returns {Object} Request modifier with webRequest event handlers
 */
export function createRequestModifier (getState, dnslinkResolver, ipfsPathValidator, runtime) {
  const browser = runtime.browser
  const runtimeRoot = browser.runtime.getURL('/')

  // Determine web extension origin for request filtering
  // Fallback to placeholder to avoid 'null' which has special meaning in security contexts
  const webExtensionOrigin = runtimeRoot ? new URL(runtimeRoot).origin : 'http://companion-origin'

  // Initialize dynamic rule set generator for Manifest V3 compatibility
  addRuleToDynamicRuleSet = addRuleToDynamicRuleSetGenerator(getState)
  /**
   * Detects if a request originated from the companion extension itself
   *
   * This function handles browser-specific inconsistencies in Origin header handling:
   * - Firefox uses originUrl (includes path, Referer-like)
   * - Chromium uses initiator (origin only, no path)
   * - Different browsers have different behaviors across versions
   *
   * Algorithm:
   * 1. Extract Origin from request metadata (originUrl or initiator)
   * 2. Normalize to origin-only format using URL constructor
   * 3. Compare with known extension origin
   *
   * Browser Compatibility Notes:
   * - Firefox Nightly 65: moz-extension://{extension-installation-id}
   * - Chromium <72: null
   * - Chromium Beta 72: chrome-extension://{uid}
   * - Firefox Nightly 85: null
   *
   * @param {Object} request - webRequest request object
   * @returns {boolean} True if request originated from companion extension
   */
  const isCompanionRequest = (request) => {
    const { originUrl, initiator } = request

    // Normalize origin extraction across browsers
    // Use fallback to prevent null origin which has special security meaning
    const requestOrigin = new URL(originUrl || initiator || 'http://missing-origin').origin

    return requestOrigin === webExtensionOrigin
  }

  // Request Classification and Caching System
  // High-performance caching to avoid redundant processing of requests
  const requestCacheConfig = { max: 128, ttl: 1000 * 30 } // 30-second TTL
  const ignoredRequests = new LRU(requestCacheConfig)
  const ignore = (requestId) => ignoredRequests.set(requestId, true)
  const isIgnored = (requestId) => ignoredRequests.get(requestId) !== undefined

  // Error tracking to prevent duplicate processing in Chromium
  // Chromium sometimes fires duplicate error events
  const errorInFlight = new LRU({ max: 3, ttl: 1000 })

  /**
   * Extracts canonical FQDN from URL, handling special IPFS subdomain cases
   *
   * Primary use case: Converting DNSLink subdomains back to their canonical form
   * Example: <fqdn>.ipns.localhost → <fqdn>
   *
   * Algorithm:
   * 1. Check if URL uses IPNS subdomain format
   * 2. If so, extract original FQDN using DNSLink resolver
   * 3. Otherwise, return hostname directly
   *
   * @param {string} url - URL to analyze
   * @returns {Promise<string>} Canonical hostname for the site
   */
  const findSiteFqdn = async (url) => {
    if (isIPFS.ipnsSubdomain(url)) {
      // Extract original FQDN from subdomain format
      // Convert: <fqdn>.ipns.gateway.tld → <fqdn>
      const originalFqdn = await dnslinkResolver.findDNSLinkHostname(url)
      if (originalFqdn) return originalFqdn
    }
    return new URL(url).hostname
  }

  /**
   * Determines canonical hostnames for both request URL and its parent page
   *
   * This is essential for:
   * - Per-site settings and opt-out detection
   * - DNSLink resolution context
   * - Security policy enforcement
   *
   * Algorithm:
   * 1. Extract FQDN from request URL
   * 2. Determine parent page URL (Firefox: originUrl, Chrome: initiator)
   * 3. Extract parent FQDN if different from request URL
   * 4. Handle special case where Chromium sets initiator to 'null'
   *
   * @param {Object} request - webRequest request object
   * @returns {Promise<Object>} Object with fqdn and parentFqdn properties
   */
  const findSiteHostnames = async (request) => {
    const { url, originUrl, initiator } = request
    const fqdn = await findSiteFqdn(url)

    // Handle browser differences in parent URL reporting
    const parentUrl = originUrl || initiator

    // Chromium explicitly sets initiator to 'null' string in some contexts
    const parentFqdn = parentUrl && parentUrl !== 'null' && url !== parentUrl
      ? await findSiteFqdn(parentUrl)
      : null

    return { fqdn, parentFqdn }
  }

  /**
   * Pre-processing filter to skip requests that shouldn't be handled
   *
   * This function implements early filtering to avoid processing requests that would:
   * - Create infinite recursion (gateway/API requests)
   * - Be incompatible with IPFS gateways (WebSocket connections)
   * - Be blocked by user preferences (opt-out settings)
   * - Be unnecessary to process (localhost requests)
   *
   * Algorithm:
   * 1. Check for recursion-prone requests (gateway/API URLs)
   * 2. Filter out incompatible request types (WebSockets)
   * 3. Skip localhost requests (not suitable for IPFS redirection)
   * 4. Apply per-site opt-out settings
   * 5. Trigger DNSLink preloading for main frame requests
   *
   * Performance Optimization:
   * - Early return prevents expensive processing
   * - Caching system avoids duplicate checks
   * - DNSLink preloading runs asynchronously
   *
   * @param {Object} state - Current companion state
   * @param {Object} request - webRequest request object
   * @returns {Promise<boolean>} True if request should be ignored
   */
  const preNormalizationSkip = async (state, request) => {
    // Prevent infinite recursion: skip requests to configured gateway or API
    if (sameGateway(request.url, state.gwURL) || sameGateway(request.url, state.apiURL)) {
      ignore(request.requestId)
    }

    // Skip WebSocket handshakes - not supported by HTTP-to-IPFS gateways
    if (request.type === 'websocket') {
      ignore(request.requestId)
    }

    // Skip localhost requests - not suitable for IPFS gateway redirection
    if (isLocalHost(request.url)) {
      ignore(request.requestId)
    }

    // Per-site opt-out handling
    const { fqdn, parentFqdn } = await findSiteHostnames(request)

    /**
     * Checks if a site matches any opt-out pattern
     * Special case: Never opt-out the canonical public gateway
     */
    const triggerOptOut = (optoutPattern) => {
      // Preserve functionality on canonical public gateway
      if (fqdn === 'gateway.ipfs.io') return false

      // Check if current or parent site matches opt-out pattern
      return fqdn.endsWith(optoutPattern) ||
             (parentFqdn && parentFqdn.endsWith(optoutPattern))
    }

    if (state.disabledOn.some(triggerOptOut)) {
      ignore(request.requestId)
    }

    // Background DNSLink preloading for main frame requests
    if (request.type === 'main_frame') {
      // Trigger asynchronous DNSLink lookup if policy allows
      // This populates the cache for potential future redirects
      if (state.dnslinkPolicy && dnslinkResolver.canLookupURL(request.url)) {
        dnslinkResolver.resolve(request.url) // Async, no await - background preload
      }
    }

    return isIgnored(request.requestId)
  }

  /**
   * Post-processing filter for additional request filtering
   *
   * Applied after initial URL normalization to catch edge cases where
   * redirection would create problematic loops or conflicts.
   *
   * Algorithm:
   * 1. Check if local gateway is available
   * 2. Prevent redirects to public gateway when no local node
   * 3. Mark request as ignored to prevent further processing
   *
   * Future Enhancement:
   * Could redirect to native ipfs:// and ipns:// protocols when
   * hasNativeProtocolHandler === true
   *
   * @param {Object} state - Current companion state
   * @param {Object} request - webRequest request object
   * @returns {boolean} True if request should be ignored
   */
  const postNormalizationSkip = (state, request) => {
    // Prevent redirect loops when local gateway is unavailable
    // If we can't redirect to local gateway, don't redirect public gateway requests
    if (!state.localGwAvailable && sameGateway(request.url, state.pubGwURL)) {
      ignore(request.requestId)
      // TODO: Implement native protocol redirect when supported
      // if (hasNativeProtocolHandler) redirect to ipfs:// or ipns://
    }

    return isIgnored(request.requestId)
  }

  // Request Handler Factory - Returns the main request modifier object
  return {
    /**
     * onBeforeRequest: Primary request interception and redirection handler
     *
     * This is the main entry point for request processing, triggered before
     * any HTTP headers are available. It handles:
     *
     * 1. Node recovery scenarios (offline local node)
     * 2. Gateway normalization for subdomain support
     * 3. API request normalization
     * 4. Protocol handler support (ipfs://, ipns://)
     * 5. IPFS content detection and redirection
     * 6. DNSLink resolution and redirection
     *
     * Processing Pipeline:
     * 1. Early state checks and request tracking
     * 2. Node recovery handling for offline scenarios
     * 3. Gateway URL normalization for optimal routing
     * 4. Pre-processing filters for request classification
     * 5. Protocol handler support for ipfs:// and ipns:// schemes
     * 6. IPFS content detection and gateway redirection
     * 7. DNSLink resolution and IPNS redirection
     *
     * @param {Object} request - webRequest request object
     * @returns {Promise<Object|undefined>} Redirect object or undefined
     */
    async onBeforeRequest (request) {
      const state = getState()

      // Early exit if companion is disabled
      if (!state.active) return

      // Track request for analytics and debugging
      observedRequestTracker.track(request)

      // Node Recovery Scenario: Offline Local Gateway
      // When local IPFS node is unreachable, show recovery page
      // allowing user to redirect to public gateway
      if (!state.nodeActive &&
          request.type === 'main_frame' &&
          sameGateway(request.url, state.gwURL)) {
        const publicGatewayUrl = await ipfsPathValidator.resolveToPublicUrl(
          request.url,
          state.pubGwURLString
        )

        // Redirect to recovery page with public gateway URL as parameter
        return handleRedirection({
          originUrl: request.url,
          redirectUrl: `${dropSlash(runtimeRoot)}${recoveryPagePath}#${encodeURIComponent(publicGatewayUrl)}`,
          request
        })
      }

      // Gateway Normalization: Subdomain Support Optimization
      // When subdomain proxy is enabled, normalize address bar requests to local gateway
      // Replace raw IP with 'localhost' hostname for go-ipfs >= 0.5 subdomain support
      if (state.redirect &&
          request.type === 'main_frame' &&
          sameGateway(request.url, state.gwURL)) {
        const normalizedUrl = safeURL(request.url, {
          useLocalhostName: state.useSubdomains
        }).toString()

        return handleRedirection({
          originUrl: request.url,
          redirectUrl: normalizedUrl,
          request
        })
      }

      // API Request Normalization: IP Address Compliance
      // Normalize API requests to use IP address for go-ipfs compatibility checks
      if (state.redirect &&
          request.type === 'main_frame' &&
          sameGateway(request.url, state.apiURL)) {
        const normalizedApiUrl = safeURL(request.url, {
          useLocalhostName: false
        }).toString()

        return handleRedirection({
          originUrl: request.url,
          redirectUrl: normalizedApiUrl,
          request
        })
      }

      // Pre-processing Filters: Early Request Classification
      if (await preNormalizationSkip(state, request)) {
        return // Request marked for skipping
      }

      // Protocol Handler Support: Unhandled IPFS Protocols
      // Fallback mechanism for browsers without native protocol handler support
      // Handles search hijacking scenarios where ipfs:// URLs become search queries
      if (state.catchUnhandledProtocols && mayContainUnhandledIpfsProtocol(request)) {
        const protocolFix = await normalizedUnhandledIpfsProtocol(request, state.pubGwURLString)
        if (protocolFix) {
          return protocolFix
        }
      }

      // Protocol Handler Support: Manifest-declared Handlers
      // Handle protocol_handlers from manifest.json (Firefox-specific)
      if (redirectingProtocolRequest(request)) {
        const manifestFix = normalizedRedirectingProtocolRequest(request, state.pubGwURLString)
        if (manifestFix) {
          return manifestFix
        }
      }

      // Main Redirection Logic: IPFS Content Detection and Gateway Routing
      if (state.redirect) {
        // Post-processing filters for edge cases
        if (postNormalizationSkip(state, request)) {
          return
        }

        // Direct IPFS/IPNS Path Detection
        // Detect valid /ipfs/ and /ipns/ paths on any website
        if (await ipfsPathValidator.publicIpfsOrIpnsResource(request.url) &&
            isSafeToRedirect(request, runtime)) {
          return redirectToGateway(request, request.url, state, ipfsPathValidator, runtime)
        }

        // DNSLink Resolution and Redirection
        // Handle decentralized websites using DNS TXT records
        if (state.dnslinkPolicy && dnslinkResolver.canLookupURL(request.url)) {
          // Active DNSLink redirection (when enabled)
          if (state.dnslinkRedirect) {
            const dnslinkGatewayUrl = await dnslinkResolver.dnslinkAtGateway(request.url)
            if (dnslinkGatewayUrl && isSafeToRedirect(request, runtime)) {
              return redirectToGateway(request, dnslinkGatewayUrl, state, ipfsPathValidator, runtime)
            }
          } else if (state.dnslinkDataPreload) {
            // Background data preloading (when redirection disabled but preloading enabled)
            dnslinkResolver.preloadData(request.url)
          }

          // Best-effort DNSLink resolution for cache population
          if (state.dnslinkPolicy === 'best-effort') {
            dnslinkResolver.resolve(request.url)
          }
        }
      }
    },

    // browser.webRequest.onBeforeSendHeaders
    // This event is triggered before sending any HTTP data, but after all HTTP headers are available.
    // This is a good place to listen if you want to modify HTTP request headers.
    onBeforeSendHeaders (request) {
      const state = getState()
      if (!state.active) return

      // Special handling of requests made to API
      if (sameGateway(request.url, state.apiURL)) {
        const { requestHeaders } = request

        if (isCompanionRequest(request)) {
          // '403 - Forbidden' fix for browsers that support blocking webRequest API (e.g. Firefox)
          // --------------------------------------------
          // We update "Origin: *-extension://" HTTP headers in requests made to API
          // by js-kubo-rpc-client running in the background page of browser
          // extension.  Without this, some users would need to do manual CORS
          // whitelisting by adding "..extension://<UUID>" to
          // API.HTTPHeaders.Access-Control-Allow-Origin in go-ipfs config.
          // With this, API calls made by browser extension look like ones made
          // by webui loaded from the API port.
          // More info:
          // Firefox 65: https://github.com/ipfs-shipyard/ipfs-companion/issues/622
          // Firefox 85: https://github.com/ipfs-shipyard/ipfs-companion/issues/955
          // Chromium 71: https://github.com/ipfs-shipyard/ipfs-companion/pull/616
          // Chromium 72: https://github.com/ipfs-shipyard/ipfs-companion/issues/630
          const foundAt = requestHeaders.findIndex(h => h.name.toLowerCase() === 'origin')
          const { origin } = state.apiURL
          if (foundAt > -1) {
            // Replace existing Origin with the origin of the API itself.
            // This removes the need for CORS setup in go-ipfs config and
            // ensures there is no HTTP Error 403 Forbidden.
            requestHeaders[foundAt].value = origin
          } else { // future-proofing
            // Origin is missing, and go-ipfs requires it in browsers:
            // https://github.com/ipfs/go-ipfs-cmds/pull/193
            requestHeaders.push({ name: 'Origin', value: origin })
          }
        }

        // Fix "http: invalid Read on closed Body"
        // ----------------------------------
        // There is a bug in go-ipfs related to keep-alive connections
        // that results in partial response for ipfs.add
        // mangled by error "http: invalid Read on closed Body"
        // More info (ipfs-companion): https://github.com/ipfs-shipyard/ipfs-companion/issues/480
        // More info (go-ipfs): https://github.com/ipfs/go-ipfs/issues/5168
        if (request.url.includes('/api/v0/add') && request.url.includes('stream-channels=true')) {
          let addExpectHeader = true
          const expectHeader = { name: 'Expect', value: '100-continue' }
          const warningMsg = 'Executing "Expect: 100-continue" workaround for ipfs.add due to https://github.com/ipfs/go-ipfs/issues/5168'
          for (const header of requestHeaders) {
            // Workaround A: https://github.com/ipfs/go-ipfs/issues/5168#issuecomment-401417420
            // (works in Firefox, but Chromium does not expose Connection header)
            /* (disabled so we use the workaround B in all browsers)
            if (header.name === 'Connection' && header.value !== 'close') {
              console.warn('[ipfs-companion] Executing "Connection: close" workaround for ipfs.add due to https://github.com/ipfs/go-ipfs/issues/5168')
              header.value = 'close'
              addExpectHeader = false
              break
            }
            */
            // Workaround B: https://github.com/ipfs-shipyard/ipfs-companion/issues/480#issuecomment-417657758
            // (works in Firefox 63 AND Chromium 67)
            if (header.name === expectHeader.name) {
              addExpectHeader = false
              if (header.value !== expectHeader.value) {
                log(warningMsg)
                header.value = expectHeader.value
              }
              break
            }
          }
          if (addExpectHeader) {
            log(warningMsg)
            requestHeaders.push(expectHeader)
          }
        }
        return { requestHeaders }
      }
    },

    // browser.webRequest.onHeadersReceived
    // Fired when the HTTP response headers associated with a request have been received.
    // You can use this event to modify HTTP response headers or do a very late redirect.
    async onHeadersReceived (request) {
      const state = getState()
      if (!state.active) return

      // Skip if request is marked as ignored
      if (isIgnored(request.requestId)) {
        return
      }

      if (state.redirect) {
        // Late redirect as a workaround for edge cases such as:
        // - CORS XHR in Firefox: https://github.com/ipfs-shipyard/ipfs-companion/issues/436
        if (runtime.requiresXHRCORSfix && onHeadersReceivedRedirect.has(request.requestId)) {
          onHeadersReceivedRedirect.delete(request.requestId)
          if (state.dnslinkPolicy) {
            const dnslinkAtGw = await dnslinkResolver.dnslinkAtGateway(request.url)
            if (dnslinkAtGw) {
              return redirectToGateway(request, dnslinkAtGw, state, ipfsPathValidator, runtime)
            }
          }
          return redirectToGateway(request, request.url, state, ipfsPathValidator, runtime)
        }

        // Detect X-Ipfs-Path Header and upgrade transport to IPFS:
        // 1. Check if DNSLink exists and redirect to it.
        // 2. If there is no DNSLink, validate path from the header and redirect
        const { url } = request
        const notActiveGatewayOrApi = !(sameGateway(url, state.pubGwURL) || sameGateway(url, state.gwURL) || sameGateway(url, state.apiURL))
        if (state.detectIpfsPathHeader && request.responseHeaders && notActiveGatewayOrApi) {
          // console.log('onHeadersReceived.request', request)
          for (const header of request.responseHeaders) {
            if (header.name.toLowerCase() === 'x-ipfs-path' && isSafeToRedirect(request, runtime)) {
              // console.log('onHeadersReceived.request.responseHeaders', request.responseHeaders.length)
              const xIpfsPath = header.value
              // First: Check if dnslink heuristic yields any results
              // Note: this depends on which dnslink lookup policy is selecten in Preferences
              if (state.dnslinkRedirect && state.dnslinkPolicy && dnslinkResolver.canLookupURL(request.url)) {
                // x-ipfs-path is a strong indicator of IPFS support
                // so we force dnslink lookup to pre-populate dnslink cache
                // in a way that works even when state.dnslinkPolicy !== 'enabled'
                // All the following requests will be upgraded to IPNS
                const cachedDnslink = await dnslinkResolver.readAndCacheDnslink(new URL(request.url).hostname)
                const dnslinkAtGw = await dnslinkResolver.dnslinkAtGateway(request.url, cachedDnslink)
                // redirect only if local node is around, as we can't guarantee DNSLink support
                // at a public subdomain gateway (requires more than 1 level of wildcard TLS certs)
                if (dnslinkAtGw && state.localGwAvailable) {
                  log(`onHeadersReceived: dnslinkRedirect from ${request.url} to ${dnslinkAtGw}`)
                  return redirectToGateway(request, dnslinkAtGw, state, ipfsPathValidator, runtime)
                }
              }
              // Additional validation of X-Ipfs-Path
              if (isIPFS.ipnsPath(xIpfsPath)) {
                // Ignore unhandled IPNS path by this point
                // (means DNSLink is disabled so we don't want to make a redirect that works like DNSLink)
                // log(`onHeadersReceived: ignoring x-ipfs-path=${xIpfsPath} (dnslinkRedirect=false, dnslinkPolicy=false or missing DNS TXT record)`)
              } else if (isIPFS.ipfsPath(xIpfsPath)) {
                // It is possible that someone exposed /ipfs/<cid>/ under /
                // and our path-based onBeforeRequest heuristics were unable
                // to identify request as IPFS one until onHeadersReceived revealed
                // presence of x-ipfs-path header.
                // Solution: convert header value to a path at public gateway
                // (optional redirect to custom one can happen later)
                const url = new URL(request.url)
                const pathWithArgs = `${xIpfsPath}${url.search}${url.hash}`
                const newUrl = pathAtHttpGateway(pathWithArgs, state.pubGwURLString)
                // redirect only if local node is around
                if (newUrl && state.localGwAvailable) {
                  log(`onHeadersReceived: normalized ${request.url} to  ${newUrl}`)
                  return redirectToGateway(request, newUrl, state, ipfsPathValidator, runtime)
                }
              }
            }
          }
        }
      }
    },

    // browser.webRequest.onErrorOccurred
    // Fired when a request could not be processed due to an error on network level.
    // For example: TCP timeout, DNS lookup failure
    // NOTE: this is executed only if webRequest.ResourceType='main_frame'
    async onErrorOccurred (request) {
      const state = getState()
      if (!state.active) return

      // Avoid duplicates in Chromium, which fires two events instead of one
      // https://github.com/ipfs-shipyard/ipfs-companion/issues/805
      if (errorInFlight.has(request.url)) return
      errorInFlight.set(request.url, request.requestId)

      // Skip additional requests produced by DNS fixup logic in Firefox
      // https://github.com/ipfs-shipyard/ipfs-companion/issues/804
      if (request.error === 'NS_ERROR_UNKNOWN_HOST' && request.url.includes('://www.')) {
        const urlBeforeFixup = request.url.replace('://www.', '://')
        if (errorInFlight.has(urlBeforeFixup)) return
      }

      // Check if error can be recovered via EthDNS
      if (isRecoverableViaEthDNS(request, state)) {
        const url = new URL(request.url)
        url.hostname = `${url.hostname}.link`
        url.protocol = 'https:' // force HTTPS, as HSTS may be missing on initial load
        const redirectUrl = url.toString()
        log(`onErrorOccurred: attempting to recover from DNS error (${request.error}) using EthDNS for ${request.url} → ${redirectUrl}`, request)
        return updateTabWithURL(request, redirectUrl, browser)
      }

      // Check if error can be recovered via DNSLink
      if (isRecoverableViaDNSLink(request, state, dnslinkResolver)) {
        const { hostname } = new URL(request.url)
        const dnslink = await dnslinkResolver.readAndCacheDnslink(hostname)
        if (dnslink) {
          const redirectUrl = await dnslinkResolver.dnslinkAtGateway(request.url, dnslink)
          log(`onErrorOccurred: attempting to recover from network error (${request.error}) using dnslink for ${request.url} → ${redirectUrl}`, request)
          // We are unable to redirect in onErrorOccurred, but we can update the tab
          return updateTabWithURL(request, redirectUrl, browser)
        }
      }

      // Cleanup after https://github.com/ipfs-shipyard/ipfs-companion/issues/436
      if (runtime.requiresXHRCORSfix && onHeadersReceivedRedirect.has(request.requestId)) {
        onHeadersReceivedRedirect.delete(request.requestId)
      }

      // Check if error can be recovered by opening same content-addresed path
      // using active gateway (public or local, depending on redirect state)
      if (await isRecoverable(request, state, ipfsPathValidator)) {
        const redirectUrl = await ipfsPathValidator.resolveToPublicUrl(request.url)
        log(`onErrorOccurred: attempting to recover from network error (${request.error}) for ${request.url} → ${redirectUrl}`, request)
        // We are unable to redirect in onErrorOccurred, but we can update the tab
        return updateTabWithURL(request, redirectUrl, browser)
      }
    },

    // browser.webRequest.onCompleted
    // Fired when HTTP request is completed (successfully or with an error code)
    // NOTE: this is executed only if webRequest.ResourceType='main_frame'
    async onCompleted (request) {
      const state = getState()
      if (!state.active) return
      if (request.statusCode === 200) return // finish if no error to recover from

      // Seamlessly fix canonical link when DNSLink breaks ipfs.io/blog/*
      /// https://github.com/ipfs/blog/issues/360
      if (request.type === 'main_frame' &&
          request.statusCode === 404 &&
          request.url.match(/\/\/[^/]+\/ipns\/ipfs\.io\/blog\//)) {
        log('onCompleted: fixing /ipns/ipfs.io/blog → /ipns/blog.ipfs.io')
        const fixedUrl = request.url.replace('/ipns/ipfs.io/blog', '/ipns/blog.ipfs.io')

        // Chromium bug: sometimes tabs.update does not work from onCompleted,
        // we run additional update after 1s just to be sure
        setTimeout(() => browser.tabs.update(request.tabId, { url: fixedUrl }), 1000)

        return browser.tabs.update(request.tabId, { url: fixedUrl })
      }

      if (await isRecoverable(request, state, ipfsPathValidator)) {
        const redirectUrl = await ipfsPathValidator.resolveToPublicUrl(request.url)
        log(`onCompleted: attempting to recover from HTTP Error ${request.statusCode} for ${request.url} → ${redirectUrl}`, request)
        return updateTabWithURL(request, redirectUrl, browser)
      }
    }
  }
}

/**
 * Handles redirection in MV2 and MV3.
 *
 * @param {object} input contains originUrl and redirectUrl.
 * @returns
 */
async function handleRedirection ({ originUrl, redirectUrl, request }) {
  if (redirectUrl !== '' && originUrl !== '' && redirectUrl !== originUrl) {
    resolvedRequestTracker.track(request)
    if (!supportsDeclarativeNetRequest()) {
      return { redirectUrl }
    }

    // Let browser handle redirection MV3 style.
    await addRuleToDynamicRuleSet({ originUrl, redirectUrl })
  }
}

// Returns a string with URL at the active gateway (local or public)
async function redirectToGateway (request, url, state, ipfsPathValidator, runtime) {
  const { resolveToPublicUrl, resolveToLocalUrl } = ipfsPathValidator
  let redirectUrl = await (state.localGwAvailable ? resolveToLocalUrl(url) : resolveToPublicUrl(url))

  // SUBRESOURCE ON HTTPS PAGE: THE WORKAROUND EXTRAVAGANZA
  // ------------------------------------------------------ \o/
  //
  // Firefox 74 does not mark *.localhost subdomains as Secure Context yet
  // (https://bugzilla.mozilla.org/show_bug.cgi?id=1220810#c23) so we can't
  // redirect there when we have IPFS resource embedded on HTTPS page (eg.
  // image loaded from a public gateway) because that would cause mixed-content
  // warning and subresource would fail to load.  Given the fact that
  // localhost/ipfs/* provided by go-ipfs 0.5+ returns a redirect to
  // *.ipfs.localhost subdomain we need to check requests for subresources, and
  // manually replace 'localhost' hostname with '127.0.0.1' (IP is hardcoded as
  // Secure Context in Firefox). The need for this workaround can be revisited
  // when Firefox closes mentioned bug.
  //
  // Chromium 80 seems to force HTTPS in the final URL (after all redirects) so
  // https://*.localhost fails TODO: needs additional research (could be a bug
  // in Chromium). For now we reuse the same workaround as Firefox.
  //
  if (state.localGwAvailable) {
    const { type, originUrl, initiator } = request
    // match request types for embedded subresources, but skip ones coming from local gateway
    const parentUrl = originUrl || initiator // FF || Chromium
    if (type !== 'main_frame' && (parentUrl && !sameGateway(parentUrl, state.gwURL))) {
      // use raw IP to ensure subresource will be loaded from the path gateway
      // at 127.0.0.1, which is marked as Secure Context in all browsers
      const useLocalhostName = false
      redirectUrl = safeURL(redirectUrl, { useLocalhostName }).toString()
    }
    // Leverage native URI support in Brave for nice address bar.
    if (type === 'main_frame' && state.ipfsNodeType === braveNodeType && !sameGateway(request.url, state.gwURL)) {
      redirectUrl = ipfsUri(redirectUrl)
      // In Brave 1.20.54 a webRequest redirect pointing at ipfs:// URI
      // is not reflected in address bar - a http://*.localhost URL is displayed instead.
      // but tabs.update works, so we do that for the main request.
      if (redirectUrl !== url) { // futureproofing in case url from request becomes native
        log('redirectToGateway: upgrading address bar to native URI', redirectUrl)
        // manually set tab to native URI
        return runtime.browser.tabs.update(request.tabId, { url: redirectUrl })
      }
    }
  }

  return handleRedirection({
    originUrl: request.url,
    redirectUrl,
    request
  })
}

function isSafeToRedirect (request, runtime) {
  const { url, type, originUrl } = request
  // Do not redirect if URL includes opt-out hint
  if (url.includes(redirectOptOutHint)) {
    return false
  }
  // Do not redirect if parent URL in address bar includes opt-out hint
  // Note: this works only in Firefox, Chromium does not provide full originUrl, only hostname in request.initiator
  if (type !== 'main_frame' && originUrl && originUrl.includes(redirectOptOutHint)) {
    return false
  }

  // Ignore XHR requests for which redirect would fail due to CORS bug in Firefox
  // See: https://github.com/ipfs-shipyard/ipfs-companion/issues/436
  if (runtime.requiresXHRCORSfix && request.type === 'xmlhttprequest' && !request.responseHeaders) {
    // Sidenote on XHR Origin: Firefox 60 uses request.originUrl, Chrome 63 uses request.initiator
    if (request.originUrl) {
      const sourceOrigin = new URL(request.originUrl).origin
      const targetOrigin = new URL(request.url).origin
      if (sourceOrigin !== targetOrigin) {
        log('Delaying redirect of CORS XHR until onHeadersReceived due to https://github.com/ipfs-shipyard/ipfs-companion/issues/436 :', request.url)
        onHeadersReceivedRedirect.add(request.requestId)
        return false
      }
    }
  }
  // Ignore requests for which redirect would fail due to Brave Shields rules
  // https://github.com/ipfs-shipyard/ipfs-companion/issues/962
  if (runtime.brave && request.type !== 'main_frame') {
    // log('Skippping redirect of IPFS subresource due to Brave Shields', request)
    return false
  }

  return true
}

// REDIRECT-BASED PROTOCOL HANDLERS
// This API is available only Firefox (protocol_handlers from manifest.json)
// Background: https://github.com/ipfs-shipyard/ipfs-companion/issues/164#issuecomment-282513891
// Notes on removal of web+ in Firefox 59: https://github.com/ipfs-shipyard/ipfs-companion/issues/164#issuecomment-355708883
// ===================================================================

// This is just a placeholder that we had to provide -- removed in normalizedRedirectingProtocolRequest()
// It has to match URL from manifest.json/protocol_handlers
const redirectingProtocolEndpoint = 'https://dweb.link/ipfs/?uri='

function redirectingProtocolRequest (request) {
  return request.url.startsWith(redirectingProtocolEndpoint)
}

function normalizedRedirectingProtocolRequest (request, pubGwUrl) {
  const oldPath = decodeURIComponent(new URL(request.url).hash)
  let path = oldPath
  // prefixed (Firefox < 59)
  path = path.replace(/^#web\+dweb:\//i, '/') // web+dweb:/ipfs/Qm → /ipfs/Qm
  path = path.replace(/^#web\+ipfs:\/\//i, '/ipfs/') // web+ipfs://Qm → /ipfs/Qm
  path = path.replace(/^#web\+ipns:\/\//i, '/ipns/') // web+ipns://Qm → /ipns/Qm
  // without prefix (Firefox >= 59)
  path = path.replace(/^#dweb:\//i, '/') // dweb:/ipfs/Qm → /ipfs/Qm
  path = path.replace(/^#ipfs:\/\//i, '/ipfs/') // ipfs://Qm → /ipfs/Qm
  path = path.replace(/^#ipns:\/\//i, '/ipns/') // ipns://Qm → /ipns/Qm
  // additional fixups of the final path
  path = fixupDnslinkPath(path) // /ipfs/example.com → /ipns/example.com
  if (oldPath !== path && isIPFS.path(path)) {
    return handleRedirection({
      originUrl: request.url,
      redirectUrl: pathAtHttpGateway(path, pubGwUrl),
      request
    })
  }
  return null
}

// idempotent /ipfs/example.com → /ipns/example.com
function fixupDnslinkPath (path) {
  if (!(path && path.startsWith('/ipfs/'))) return path
  const [, root] = path.match(/^\/ipfs\/([^/?#]+)/)
  if (root && !isIPFS.cid(root) && isFQDN(root)) {
    return path.replace(/^\/ipfs\//, '/ipns/')
  }
  return path
}

// SEARCH-HIJACK HANDLERS: UNIVERSAL FALLBACK FOR UNHANDLED PROTOCOLS
// (Used in Chrome and other browsers that do not provide better alternatives)
// Background: https://github.com/ipfs-shipyard/ipfs-companion/issues/164#issuecomment-328374052
// ===================================================================

const unhandledIpfsRE = /=(?:web%2B|)(ipfs(?=%3A%2F%2F)|ipns(?=%3A%2F%2F)|dweb(?=%3A%2Fip[f|n]s))%3A(?:%2F%2F|%2F)([^&]+)/

function mayContainUnhandledIpfsProtocol (request) {
  return request.type === 'main_frame' && request.url.includes('%3A%2F')
}

function unhandledIpfsPath (requestUrl) {
  const unhandled = requestUrl.match(unhandledIpfsRE)
  if (unhandled && unhandled.length > 1) {
    const unhandledProtocol = decodeURIComponent(unhandled[1])
    const unhandledPath = `/${decodeURIComponent(unhandled[2])}`
    return isIPFS.path(unhandledPath) ? unhandledPath : `/${unhandledProtocol}${unhandledPath}`
  }
  return null
}

function normalizedUnhandledIpfsProtocol (request, pubGwUrl) {
  let path = unhandledIpfsPath(request.url)
  path = fixupDnslinkPath(path) // /ipfs/example.com → /ipns/example.com
  if (isIPFS.path(path)) {
    // replace search query with a request to a public gateway
    // (will be redirected later, if needed)
    return handleRedirection({
      originUrl: request.url,
      redirectUrl: pathAtHttpGateway(path, pubGwUrl),
      request

    })
  }
}

// RECOVERY OF FAILED REQUESTS
// ===================================================================

// Recovery check for onErrorOccurred (request.error) and onCompleted (request.statusCode)
async function isRecoverable (request, state, ipfsPathValidator) {
  // Note: we are unable to recover default public gateways without a local one
  const { error, statusCode, url } = request
  const { redirect, localGwAvailable, pubGwURL, pubSubdomainGwURL } = state
  return (state.recoverFailedHttpRequests &&
    request.type === 'main_frame' &&
    (recoverableNetworkErrors.has(error) ||
      recoverableHttpError(statusCode)) &&
    await ipfsPathValidator.publicIpfsOrIpnsResource(url) &&
    ((redirect && localGwAvailable) ||
      (!sameGateway(url, pubGwURL) &&
       !sameGateway(url, pubSubdomainGwURL))))
}

// Recovery check for onErrorOccurred (request.error)
function isRecoverableViaDNSLink (request, state, dnslinkResolver) {
  const recoverableViaDnslink =
    state.recoverFailedHttpRequests &&
    request.type === 'main_frame' &&
    state.dnslinkPolicy &&
    recoverableNetworkErrors.has(request.error)
  return recoverableViaDnslink && dnslinkResolver.canLookupURL(request.url)
}

// Recovery check for onErrorOccurred (request.error)
function isRecoverableViaEthDNS (request, state) {
  return state.recoverFailedHttpRequests &&
    request.type === 'main_frame' &&
    recoverableNetworkErrors.has(request.error) &&
    new URL(request.url).hostname.endsWith('.eth')
}

// We can't redirect in onErrorOccurred/onCompleted
// Indead, we recover by opening URL in a new tab that replaces the failed one
// TODO: display an user-friendly prompt when the very first recovery is done
async function updateTabWithURL (request, redirectUrl, browser) {
  // Do nothing if the URL remains the same
  if (request.url === redirectUrl) return

  return browser.tabs.update(request.tabId, {
    active: true,
    url: redirectUrl
  })
}
