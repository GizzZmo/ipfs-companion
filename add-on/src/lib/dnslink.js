'use strict'
/* eslint-env browser */

import Pqueue from 'p-queue'

import debug from 'debug'
import IsIpfs from 'is-ipfs'
import LRU from 'lru-cache'
import { offlinePeerCount } from './state.js'
import { ipfsContentPath, sameGateway, pathAtHttpGateway } from './ipfs-path.js'

/**
 * IPFS Companion DNSLink Resolver
 *
 * This module provides comprehensive DNSLink resolution capabilities for IPFS Companion.
 * DNSLink is a protocol that uses DNS TXT records to map domain names to IPFS content,
 * enabling decentralized websites with human-readable domain names.
 *
 * Core Functionality:
 * 1. DNS TXT record lookup and caching for DNSLink discovery
 * 2. IPNS path conversion and gateway URL generation
 * 3. Background preloading of IPFS content for performance
 * 4. Queue-based concurrent processing for optimal resource usage
 * 5. Intelligent caching with TTL for reduced DNS load
 *
 * DNSLink Protocol Overview:
 * - DNS TXT records contain: dnslink=/ipfs/<hash> or dnslink=/ipns/<name>
 * - Enables mapping: example.com → /ipfs/QmHash or /ipns/example.eth
 * - Supports website hosting on IPFS with custom domains
 * - Provides content integrity through cryptographic hashing
 *
 * Performance Optimizations:
 * - LRU cache with 12-hour TTL reduces DNS queries
 * - Concurrent lookup queues prevent blocking operations
 * - Background preloading for frequently accessed content
 * - Separate queues for lookup and preload operations
 *
 * Architecture Pattern: Factory Function
 * - Returns resolver object with closure over configuration
 * - Enables dependency injection for testability
 * - Maintains state isolation between instances
 *
 * @author IPFS Companion Team
 * @license CC0-1.0
 */

const log = debug('ipfs-companion:dnslink')
log.error = debug('ipfs-companion:dnslink:error')

/**
 * Creates a DNSLink resolver with comprehensive caching and queue management
 *
 * @param {Function} getState - Function that returns current companion state
 * @returns {Object} DNSLink resolver with methods for lookup, caching, and preloading
 */
export default function createDnslinkResolver (getState) {
  // Cache Configuration - Optimized for DNSLink lookup patterns
  // 12-hour TTL balances performance with content freshness
  const cacheConfiguration = {
    max: 1000, // Maximum cache entries
    ttl: 1000 * 60 * 60 * 12 // 12-hour TTL (43,200,000ms)
  }

  // Primary DNSLink result cache
  const dnslinkCache = new LRU(cacheConfiguration)

  // Queue Management - Prevents resource exhaustion and ensures optimal performance
  // Separate queues for different operation types allow fine-tuned concurrency control
  const lookupQueue = new Pqueue({ concurrency: 4 }) // Background DNSLink lookups
  const preloadQueue = new Pqueue({ concurrency: 4 }) // Content preloading operations

  // Preload URL tracking cache - Prevents duplicate preload operations
  const preloadUrlCache = new LRU(cacheConfiguration)

  // DNSLink Resolver Object - Public API for DNSLink operations
  const dnslinkResolver = {

    /**
     * Cache Access Methods
     * Provides controlled access to internal cache for debugging and testing
     */
    get _cache () {
      return dnslinkCache
    },

    /**
     * Manually set a DNSLink record in the cache
     *
     * Useful for:
     * - Pre-populating cache with known records
     * - Testing scenarios with controlled data
     * - Manual cache warm-up operations
     *
     * @param {string} fqdn - Fully qualified domain name
     * @param {string|boolean} value - DNSLink value or false if no record exists
     */
    setDnslink (fqdn, value) {
      dnslinkCache.set(fqdn, value)
    },

    /**
     * Clear all cached DNSLink records
     *
     * Useful for:
     * - Force refresh of all DNSLink data
     * - Testing scenarios requiring clean state
     * - Manual cache invalidation
     */
    clearCache () {
      dnslinkCache.clear()
    },

    /**
     * Retrieve cached DNSLink record without triggering lookup
     *
     * Algorithm:
     * 1. Check cache for FQDN
     * 2. Return cached value (string) or false (no record) or undefined (not cached)
     *
     * @param {string} fqdn - Fully qualified domain name
     * @returns {string|boolean|undefined} Cached DNSLink value, false if no record, undefined if not cached
     */
    cachedDnslink (fqdn) {
      return dnslinkCache.get(fqdn)
    },

    /**
     * Determine if a URL is eligible for DNSLink lookup
     *
     * Safety checks to prevent:
     * - Infinite recursion (gateway/API URLs)
     * - Unnecessary processing (non-HTTP URLs)
     * - Policy violations (DNSLink disabled)
     * - Performance issues (IPFS URLs)
     *
     * Algorithm:
     * 1. Check if DNSLink policy is enabled
     * 2. Verify URL uses HTTP/HTTPS protocol
     * 3. Ensure URL is not already an IPFS resource
     * 4. Prevent recursion with gateway/API URLs
     *
     * @param {string} requestUrl - URL to evaluate for DNSLink lookup eligibility
     * @returns {boolean} True if URL can be safely looked up for DNSLink
     */
    canLookupURL (requestUrl) {
      const state = getState()

      return state.dnslinkPolicy && // DNSLink policy enabled
             requestUrl.startsWith('http') && // HTTP/HTTPS protocol
             !IsIpfs.url(requestUrl) && // Not already IPFS URL
             !sameGateway(requestUrl, state.apiURL) && // Not API endpoint
             !sameGateway(requestUrl, state.gwURL) // Not gateway endpoint
    },

    /**
     * Generate gateway URL for DNSLink-enabled domain
     *
     * Converts a regular HTTP URL to an IPFS gateway URL using DNSLink resolution.
     * Chooses appropriate gateway (local vs public) based on availability and configuration.
     *
     * Algorithm:
     * 1. Validate URL format (convert string to URL object if needed)
     * 2. Check if domain can redirect to IPNS using DNSLink
     * 3. Convert URL to IPNS path format
     * 4. Select optimal gateway (local if available and enabled, otherwise public)
     * 5. Generate final gateway URL
     *
     * Gateway Selection Logic:
     * - Local gateway: Used when redirect enabled and local node available
     * - Public gateway: Fallback when local gateway unavailable
     *
     * @param {string|URL} url - URL to convert to gateway format
     * @param {string} [dnslink] - Optional pre-resolved DNSLink record
     * @returns {Promise<string|undefined>} Gateway URL or undefined if conversion not possible
     */
    async dnslinkAtGateway (url, dnslink) {
      // Normalize URL input to URL object
      if (typeof url === 'string') {
        url = new URL(url)
      }

      // Check if domain has valid DNSLink and can redirect to IPNS
      if (await dnslinkResolver.canRedirectToIpns(url, dnslink)) {
        const state = getState()

        // Convert domain URL to IPNS path format
        // Example: https://example.com/path → /ipns/example.com/path
        const ipnsPath = dnslinkResolver.convertToIpnsPath(url)

        // Select optimal gateway based on configuration and availability
        const gatewayBaseUrl = state.redirect && state.localGwAvailable
          ? state.gwURLString // Local gateway preferred
          : state.pubGwURLString // Public gateway fallback

        // Generate final gateway URL
        // See: https://github.com/ipfs/ipfs-companion/issues/298
        return pathAtHttpGateway(ipnsPath, gatewayBaseUrl)
      }
    },

    /**
     * Read and cache DNSLink record with intelligent caching strategy
     *
     * This is the core caching logic that balances performance with data freshness.
     * Implements a cache-first strategy with background refresh capability.
     *
     * Algorithm:
     * 1. Check cache for existing DNSLink record
     * 2. If cached: return immediately (performance optimization)
     * 3. If not cached: perform DNS TXT lookup
     * 4. Cache result (both positive and negative) to prevent repeated lookups
     * 5. Log operation for debugging and monitoring
     *
     * Caching Strategy:
     * - Positive results: Cache actual DNSLink value with TTL
     * - Negative results: Cache 'false' to prevent repeated failed lookups
     * - Error handling: Log errors but don't cache to allow retry
     *
     * Performance Optimization:
     * - Most operations hit cache, avoiding expensive DNS queries
     * - Negative result caching prevents DNS query storms
     * - Structured logging for operational visibility
     *
     * @param {string} fqdn - Fully qualified domain name to lookup
     * @returns {Promise<string|boolean>} DNSLink value or false if no record
     */
    async readAndCacheDnslink (fqdn) {
      let dnslink = dnslinkResolver.cachedDnslink(fqdn)

      // Cache hit - return immediately for optimal performance
      if (typeof dnslink !== 'undefined') {
        // Note: Detailed cache hit logging is disabled to reduce noise
        // Most operations hit cache, making this log too verbose
        return dnslink
      }

      // Cache miss - perform DNS lookup and cache result
      try {
        log(`DNSLink cache miss for '${fqdn}', performing DNS TXT lookup`)
        dnslink = await dnslinkResolver.readDnslinkFromTxtRecord(fqdn)

        if (dnslink) {
          // Positive result: cache DNSLink value
          dnslinkResolver.setDnslink(fqdn, dnslink)
          log(`DNSLink found: '${fqdn}' → '${dnslink}'`)
        } else {
          // Negative result: cache false to prevent repeated lookups
          dnslinkResolver.setDnslink(fqdn, false)
          log(`No DNSLink record found for '${fqdn}'`)
        }
      } catch (error) {
        // Error handling: log but don't cache to allow retry
        log.error(`DNSLink lookup error for '${fqdn}':`, error)
      }

      return dnslink
    },

    /**
     * Background DNSLink resolution with queue management
     *
     * Performs asynchronous DNSLink lookup in a managed queue to prevent
     * resource exhaustion while maintaining responsiveness.
     *
     * Algorithm:
     * 1. Validate URL eligibility for DNSLink lookup
     * 2. Extract hostname from URL
     * 3. Check cache for immediate result
     * 4. If not cached, queue background lookup operation
     * 5. Return queued promise for eventual result
     *
     * Queue Management Benefits:
     * - Prevents overwhelming DNS servers with concurrent requests
     * - Maintains browser responsiveness during bulk operations
     * - Provides backpressure for rate limiting
     *
     * Use Cases:
     * - Background preloading during page navigation
     * - Bulk DNSLink discovery operations
     * - Best-effort resolution without blocking UI
     *
     * @param {string} url - URL to resolve DNSLink for
     * @returns {Promise<string|boolean|undefined>} DNSLink value, false if no record, undefined if ineligible
     */
    async resolve (url) {
      // Early exit for ineligible URLs
      if (!dnslinkResolver.canLookupURL(url)) return

      const fqdn = new URL(url).hostname
      const cachedResult = dnslinkResolver.cachedDnslink(fqdn)

      // Return immediate result if available in cache
      if (cachedResult) return cachedResult

      // Queue background lookup to avoid blocking and manage concurrency
      return lookupQueue.add(() => {
        return dnslinkResolver.readAndCacheDnslink(fqdn)
      })
    },

    /**
     * Preload IPFS content for DNSLink domain to improve performance
     *
     * This function performs background content preloading to improve user experience
     * by reducing initial load times for frequently accessed DNSLink sites.
     *
     * Algorithm:
     * 1. Validate preload conditions (enabled, not already redirecting, etc.)
     * 2. Check preload cache to prevent duplicate operations
     * 3. Resolve DNSLink for the domain
     * 4. Verify local gateway availability and peer connectivity
     * 5. Queue HEAD request to preload content
     *
     * Preload Conditions:
     * - DNSLink data preload must be enabled
     * - DNSLink redirect must be disabled (otherwise redirect handles loading)
     * - URL must not be already preloaded (tracked in cache)
     * - Local gateway must be available
     * - At least one peer must be connected
     *
     * Performance Benefits:
     * - Reduces initial load time for DNSLink sites
     * - Background operation doesn't block user interaction
     * - Queue management prevents resource exhaustion
     *
     * @param {string} url - URL to preload content for
     * @returns {Promise<URL|undefined>} Preload URL if successful, undefined otherwise
     */
    async preloadData (url) {
      const state = getState()

      // Early validation checks for preload eligibility
      if (!state.dnslinkDataPreload || state.dnslinkRedirect) return
      if (preloadUrlCache.get(url)) return // Already preloaded

      // Mark URL as preloaded to prevent duplicates
      preloadUrlCache.set(url, true)

      // Resolve DNSLink for the domain
      const dnslink = await dnslinkResolver.resolve(url)
      if (!dnslink) return // No DNSLink record found

      // Verify local infrastructure availability
      if (!state.localGwAvailable) return // Local gateway required
      if (state.peerCount < 1) return // At least one peer required

      // Queue preload operation to manage resource usage
      return preloadQueue.add(async () => {
        const { pathname } = new URL(url)
        const preloadUrl = new URL(state.gwURLString)
        preloadUrl.pathname = `${dnslink}${pathname}`

        // Perform HEAD request to trigger content resolution without downloading
        await fetch(preloadUrl.toString(), { method: 'HEAD' })
        return preloadUrl
      })
    },

    /**
     * Low-level DNSLink lookup via DNS TXT record resolution
     *
     * This function performs the actual DNS resolution to discover DNSLink records.
     * It handles API provider selection, request formatting, and response validation.
     *
     * Algorithm:
     * 1. Determine optimal API provider (local vs public)
     * 2. Construct DNS resolution API call
     * 3. Execute HTTP request with proper headers
     * 4. Validate response and extract DNSLink value
     * 5. Perform IPFS path validation
     *
     * API Provider Selection:
     * - Local gateway: Used when peers are connected (preferred)
     * - Public gateway: Fallback when local node is offline
     *
     * Browser Compatibility:
     * - Uses gateway port for GET requests to avoid CORS issues
     * - Chromium doesn't execute onBeforeSendHeaders for sync extension calls
     * - This limitation requires using gateway endpoint instead of API endpoint
     *
     * Error Handling:
     * - HTTP errors are propagated to caller
     * - Invalid IPFS paths are rejected with descriptive errors
     * - Network failures are logged and re-thrown
     *
     * @param {string} fqdn - Fully qualified domain name to lookup
     * @returns {Promise<string|null>} DNSLink value if found, null if no record
     */
    async readDnslinkFromTxtRecord (fqdn) {
      const state = getState()

      // Select optimal API provider based on node connectivity
      let apiProviderUrl
      if (state.peerCount !== offlinePeerCount) {
        // Local gateway preferred - avoids external dependencies
        // Using gateway port for GET request compatibility
        apiProviderUrl = state.gwURLString
      } else {
        // Public gateway fallback when local node offline
        apiProviderUrl = 'https://ipfs.io/'
      }

      // Construct DNS resolution API endpoint
      // Uses IPFS name resolution API to query DNS TXT records
      const resolutionEndpoint = `${apiProviderUrl}api/v0/name/resolve/${fqdn}?r=false`

      // Execute DNS resolution request
      const response = await fetch(resolutionEndpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      })

      // Process successful response
      if (response.ok) {
        const { Path: dnslinkPath } = await response.json()

        // Validate extracted DNSLink is a valid IPFS path
        if (!IsIpfs.path(dnslinkPath)) {
          throw new Error(`DNSLink for '${fqdn}' is not a valid IPFS path: '${dnslinkPath}'`)
        }

        return dnslinkPath
      } else if (response.status === 500) {
        // Handle go-ipfs specific behavior for missing DNSLink records
        // go-ipfs returns HTTP 500 for both missing records and actual errors
        // TODO: Request upstream improvement for more intuitive error codes
        return null
      } else {
        // Propagate HTTP errors with descriptive messages
        throw new Error(`DNS resolution failed: ${response.status} ${response.statusText}`)
      }
    },

    /**
     * Determine if a URL can be redirected to IPNS via DNSLink
     *
     * This function implements intelligent path analysis to avoid conflicts with
     * existing IPFS gateway functionality while enabling DNSLink redirects.
     *
     * Algorithm:
     * 1. Normalize URL input format
     * 2. Check for HTTP gateway paths that should be excluded
     * 3. Apply DNSLink policy based on configuration
     * 4. Perform DNSLink lookup (cached or live based on policy)
     * 5. Return redirect eligibility decision
     *
     * Path Exclusion Logic:
     * Skips URLs with paths that indicate existing IPFS gateway usage:
     * - /ipfs/* : Direct IPFS content addressing
     * - /ipns/* : Direct IPNS addressing
     * - /api/v* : IPFS API endpoints
     *
     * DNSLink Policy Modes:
     * - 'enabled': Performs live lookup for every hostname (high accuracy, higher latency)
     * - 'best-effort': Uses cached results only (lower latency, may miss recent changes)
     *
     * Performance Considerations:
     * - Caches results to minimize DNS overhead
     * - Policy selection balances accuracy vs performance
     * - Background lookup population improves cache hit rate
     *
     * @param {string|URL} url - URL to evaluate for IPNS redirect eligibility
     * @param {string} [dnslink] - Optional pre-resolved DNSLink record
     * @returns {Promise<boolean>} True if URL can be redirected to IPNS
     */
    async canRedirectToIpns (url, dnslink) {
      // Normalize URL input to URL object
      if (typeof url === 'string') {
        url = new URL(url)
      }

      // Safety Check: Exclude HTTP gateway paths to prevent conflicts
      // These paths indicate existing IPFS functionality that shouldn't be interfered with
      const urlPath = url.pathname
      const isHttpGatewayPath = urlPath.startsWith('/ipfs/') ||
                               urlPath.startsWith('/ipns/') ||
                               urlPath.startsWith('/api/v')

      if (!isHttpGatewayPath) {
        const fqdn = url.hostname

        // Apply DNSLink lookup policy
        // 'enabled' policy: Live lookup for maximum accuracy (higher latency)
        // 'best-effort' policy: Cache-only lookup for better performance
        const resolvedDnslink = dnslink ||
          await (getState().dnslinkPolicy === 'enabled'
            ? dnslinkResolver.readAndCacheDnslink(fqdn)
            : dnslinkResolver.cachedDnslink(fqdn))

        // Redirect is possible if DNSLink record exists
        if (resolvedDnslink) {
          return true
        }
      }

      return false
    },

    /**
     * Convert standard HTTP URL to IPNS path format
     *
     * Transforms a regular domain-based URL into IPNS path format suitable
     * for IPFS gateway routing. Preserves all URL components (path, search, hash).
     *
     * Algorithm:
     * 1. Normalize URL input to URL object
     * 2. Extract hostname as IPNS name
     * 3. Preserve pathname, search params, and hash fragment
     * 4. Construct IPNS path: /ipns/{hostname}{pathname}{search}{hash}
     *
     * Examples:
     * - https://example.com/path → /ipns/example.com/path
     * - https://blog.ipfs.io/post/1?ref=home#intro → /ipns/blog.ipfs.io/post/1?ref=home#intro
     *
     * @param {string|URL} url - URL to convert to IPNS path format
     * @returns {string} IPNS path with preserved URL components
     */
    convertToIpnsPath (url) {
      if (typeof url === 'string') {
        url = new URL(url)
      }

      // Construct IPNS path preserving all URL components
      return `/ipns/${url.hostname}${url.pathname}${url.search}${url.hash}`
    },

    /**
     * Find DNSLink hostname from URL in various formats
     *
     * This function handles DNSLink discovery across different URL formats:
     * - Direct hostname: https://example.com → example.com
     * - IPNS path gateway: https://gateway.com/ipns/example.com → example.com
     * - IPNS subdomain gateway: https://example-com.ipns.gateway.com → example.com
     *
     * Algorithm:
     * 1. Extract IPFS content path from URL (handles subdomain normalization)
     * 2. If IPNS path format, extract and validate IPNS root
     * 3. Verify IPNS root is not a CID (should be FQDN for DNSLink)
     * 4. Confirm DNSLink record exists for extracted FQDN
     * 5. Fallback to checking main hostname if path analysis fails
     *
     * Validation Steps:
     * - Exclude CIDs from IPNS root (DNSLink requires FQDN)
     * - Verify DNSLink record exists via DNS lookup
     * - Cache results to improve performance
     *
     * @param {string} url - URL to analyze for DNSLink hostname
     * @returns {Promise<string|undefined>} FQDN with DNSLink record, undefined if none found
     */
    async findDNSLinkHostname (url) {
      if (!url) return

      // Extract normalized IPFS content path (handles subdomain gateways)
      const normalizedContentPath = ipfsContentPath(url)

      if (IsIpfs.ipnsPath(normalizedContentPath)) {
        // Extract IPNS root from path format: /ipns/{root}/... → {root}
        const ipnsRootMatch = normalizedContentPath.match(/^\/ipns\/([^/]+)/)
        if (ipnsRootMatch) {
          const ipnsRoot = ipnsRootMatch[1]

          // Validate: IPNS root should be FQDN, not CID (DNSLink uses domain names)
          if (!IsIpfs.cid(ipnsRoot)) {
            // Verify DNSLink record exists for this FQDN
            if (await dnslinkResolver.readAndCacheDnslink(ipnsRoot)) {
              return ipnsRoot
            }
          }
        }
      }

      // Fallback: Check main hostname for DNSLink record
      const { hostname } = new URL(url)
      if (await dnslinkResolver.readAndCacheDnslink(hostname)) {
        return hostname
      }
    }

  }

  return dnslinkResolver
}
