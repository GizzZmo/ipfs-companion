'use strict'
/* eslint-env browser, webextensions */

import browser from 'webextension-polyfill'
import PQueue from 'p-queue'

/**
 * IPFS Companion DOM Linkifier
 *
 * This content script automatically converts plain text IPFS/IPNS addresses into clickable links.
 * It uses a sophisticated approach to scan DOM text nodes and replace IPFS content identifiers
 * with proper hyperlinks pointing to the configured gateway.
 *
 * Performance Optimizations:
 * - Uses job queues to prevent UI blocking on large DOMs
 * - Implements validation caching to avoid redundant API calls
 * - Employs MutationObserver for dynamic content handling
 * - Uses XPath queries for efficient text node selection
 *
 * Architecture:
 * 1. Initial DOM scan using XPath to find text nodes containing IPFS patterns
 * 2. Queue-based processing to handle linkification without blocking UI
 * 3. MutationObserver for handling dynamically added content
 * 4. Validation cache to store IPFS path validity results
 *
 * Supported Patterns:
 * - /ipfs/[hash] - IPFS content addressing
 * - /ipns/[name] - IPNS mutable naming
 * - ipfs://[hash] - IPFS protocol scheme
 * - ipns://[name] - IPNS protocol scheme
 * - dweb:/ipfs/[hash] - Distributed web scheme
 * - dweb:/ipns/[name] - Distributed web IPNS scheme
 *
 * @author IPFS Companion Team
 * @license CC0-1.0
 */

/**
 * Main execution wrapper using IIFE (Immediately Invoked Function Expression)
 * Prevents execution if the script has already been loaded to avoid duplicate processing
 *
 * @param {boolean} alreadyLoaded - Flag indicating if the linkification script is already active
 */
;(function (alreadyLoaded) {
  // Early exit if script already running - prevents duplicate linkification
  if (alreadyLoaded) {
    return
  }

  // Content type validation - only process HTML and plain text documents
  // This optimization prevents unnecessary processing on binary content types
  if (document.contentType !== undefined &&
      document.contentType !== 'text/plain' &&
      document.contentType !== 'text/html') {
    return
  }

  // Global state initialization
  // Set linkification lock to prevent re-execution
  window.ipfsCompanionLinkifiedDOM = true
  // Initialize validation cache for IPFS path validation results
  window.ipfsCompanionLinkifyValidationCache = new Map()

  // IPFS URL Pattern Matching Configuration
  // Regular expression to match various IPFS/IPNS URL formats
  // Matches: /ipfs/, /ipns/, dweb:/ipfs/, dweb:/ipns/, ipns://, ipfs://
  const urlRE = /(?:\s+|^)(\/ip(?:f|n)s\/|dweb:\/ip(?:f|n)s\/|ipns:\/\/|ipfs:\/\/)([^\s+"<>:]+)/g

  // DOM Element Whitelist Configuration
  // Define safe parent elements where linkification is allowed
  // This prevents linkification in sensitive areas like forms, scripts, etc.
  const allowedParents = [
    'abbr', 'acronym', 'address', 'applet', 'b', 'bdo', 'big', 'blockquote', 'body',
    'caption', 'center', 'cite', 'code', 'dd', 'del', 'div', 'dfn', 'dt', 'em',
    'fieldset', 'font', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'i', 'iframe',
    'ins', 'kdb', 'li', 'object', 'pre', 'p', 'q', 'samp', 'small', 'span', 'strike',
    's', 'strong', 'sub', 'sup', 'td', 'th', 'tt', 'u', 'var'
  ]

  // XPath Query Configuration
  // Optimized XPath expression to find text nodes containing IPFS patterns
  // Only selects text nodes with specific IPFS content in allowed parent elements
  const textNodeXpath = './/text()[' +
    "(contains(., '/ipfs/') or contains(., '/ipns/') or contains(., 'ipns:/') or contains(., 'ipfs:/')) and " +
    'not(ancestor::a) and not(ancestor::script) and not(ancestor::style) and ' +
    '(parent::' + allowedParents.join(' or parent::') + ') ' +
    ']'

  /**
   * Initialize the IPFS DOM linkification system
   *
   * Algorithm:
   * 1. Create a job queue with concurrency=1 to prevent race conditions
   * 2. Perform initial linkification of document.body
   * 3. Set up MutationObserver to handle dynamic content changes
   *
   * Performance Notes:
   * - Sequential job processing prevents DOM race conditions in large documents
   * - MutationObserver only activates after initial scan is complete
   * - Observes characterData, childList, and subtree changes for comprehensive coverage
   */
  function init () {
    // Create job queue for sequential processing - prevents race conditions in large DOMs
    // Concurrency=1 ensures DOM modifications don't interfere with each other
    const linkifyJobs = new PQueue({ concurrency: 1 })

    // Perform initial linkification scan of the entire document body
    linkifyContainer(document.body, linkifyJobs)
      .then(() => {
        // Set up dynamic content monitoring after initial scan completes
        // MutationObserver watches for DOM changes and linkifies new content
        new MutationObserver(function (mutations) {
          // Process each mutation asynchronously to maintain responsiveness
          mutations.forEach(async (mutation) => linkifyMutation(mutation, linkifyJobs))
        }).observe(document.body, {
          characterData: true, // Text content changes
          childList: true, // Node additions/removals
          subtree: true // Monitor entire subtree
        })
      })
  }

  /**
   * Handle DOM mutations by queuing linkification jobs
   *
   * Processes two types of mutations:
   * 1. childList: New nodes added to DOM (text nodes and container elements)
   * 2. characterData: Existing text content modified
   *
   * Algorithm:
   * 1. For childList mutations: iterate through addedNodes
   *    - If TEXT_NODE: queue linkification of the text node
   *    - If other node type: queue container linkification
   * 2. For characterData mutations: queue linkification of modified text node
   * 3. Wait for all queued jobs to complete before returning
   *
   * @param {MutationRecord} mutation - DOM mutation record from MutationObserver
   * @param {PQueue} linkifyJobs - Job queue for sequential processing (optional, creates new if not provided)
   */
  async function linkifyMutation (mutation, linkifyJobs) {
    // Initialize job queue if not provided (fallback for safety)
    linkifyJobs = linkifyJobs || new PQueue({ concurrency: 1 })

    // Handle new nodes added to DOM
    if (mutation.type === 'childList') {
      for (const addedNode of mutation.addedNodes) {
        if (addedNode.nodeType === Node.TEXT_NODE) {
          // Direct text node - queue for immediate linkification
          linkifyJobs.add(async () => linkifyTextNode(addedNode))
        } else {
          // Container node - scan for text nodes within
          linkifyJobs.add(async () => linkifyContainer(addedNode))
        }
      }
    }

    // Handle text content changes in existing nodes
    if (mutation.type === 'characterData') {
      linkifyJobs.add(async () => linkifyTextNode(mutation.target))
    }

    // Wait for all linkification jobs to complete before proceeding
    await linkifyJobs.onIdle()
  }

  /**
   * Scan a container element for text nodes containing IPFS patterns and queue them for linkification
   *
   * Algorithm:
   * 1. Validate container element (skip if editable or already linkified)
   * 2. Use XPath to efficiently find text nodes with IPFS patterns
   * 3. Filter out nodes no longer in DOM (performance optimization)
   * 4. Queue each valid text node for linkification
   * 5. Wait for all jobs to complete
   *
   * Performance Optimizations:
   * - XPath query is more efficient than DOM traversal
   * - Early validation prevents unnecessary processing
   * - Container validation checks prevent infinite recursion
   *
   * @param {Element} container - DOM element to scan for IPFS text content
   * @param {PQueue} linkifyJobs - Job queue for sequential processing (optional)
   */
  async function linkifyContainer (container, linkifyJobs) {
    // Validate container element
    if (!container || !container.nodeType || container.isContentEditable) {
      return
    }

    // Prevent infinite recursion - skip already linkified containers
    if (container.className && container.className.match &&
        container.className.match(/\blinkifiedIpfsAddress\b/)) {
      return
    }

    // Use XPath to efficiently locate text nodes containing IPFS patterns
    // This is much faster than manual DOM traversal for large documents
    const xpathResult = document.evaluate(
      textNodeXpath,
      container,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    )

    // Initialize job queue if not provided
    linkifyJobs = linkifyJobs || new PQueue({ concurrency: 1 })

    // Process each text node found by XPath query
    let nodeIndex = 0
    let currentTextNode = null

    while ((currentTextNode = xpathResult.snapshotItem(nodeIndex++))) {
      const parentElement = currentTextNode.parentNode

      // Skip nodes that are no longer in visible DOM (performance optimization)
      // This can happen in dynamic pages where content is modified during processing
      if (!parentElement || !container.contains(currentTextNode)) {
        continue
      }

      // Capture node reference for async processing (prevents closure issues)
      const nodeToProcess = currentTextNode
      linkifyJobs.add(async () => linkifyTextNode(nodeToProcess))
    }

    // Wait for all linkification jobs to complete
    await linkifyJobs.onIdle()
  }

  /**
   * Convert matched IPFS text patterns to valid IPFS resource URLs
   *
   * Handles protocol normalization for various IPFS URI schemes:
   * - ipfs:// → /ipfs/
   * - ipns:// → /ipns/
   * - dweb:/ipfs/ → /ipfs/
   * - dweb:/ipns/ → /ipns/
   *
   * Algorithm:
   * 1. Extract protocol scheme and path from regex match
   * 2. Clean up path by removing trailing punctuation
   * 3. Normalize protocol schemes to standard gateway format
   * 4. Validate the resulting IPFS path
   *
   * @param {Array} match - Regex match array [fullMatch, protocol, path]
   * @returns {Promise<string|null>} Valid IPFS gateway URL or null if invalid
   */
  function textToIpfsResource (match) {
    let protocolScheme = match[1]
    let resourcePath = match[2]

    // Clean up path - remove trailing punctuation that's not part of the hash/name
    // This handles cases like "Check out /ipfs/hash." where the period shouldn't be included
    resourcePath = resourcePath.replace(/[.,]*$/, '')

    // Normalize various protocol schemes to standard gateway format
    switch (protocolScheme) {
      case 'ipfs://':
        protocolScheme = '/ipfs/'
        break
      case 'ipns://':
        protocolScheme = '/ipns/'
        break
      case 'dweb:/ipfs/':
        protocolScheme = '/ipfs/'
        break
      case 'dweb:/ipns/':
        protocolScheme = '/ipns/'
        break
      // '/ipfs/' and '/ipns/' already in correct format
    }

    // Validate and return the constructed IPFS path
    return validIpfsResource(protocolScheme + resourcePath)
  }

  /**
   * Validate IPFS resource path and return gateway URL if valid
   *
   * Uses caching to improve performance on pages with repeated IPFS paths.
   * Cache prevents redundant validation API calls for the same resource.
   *
   * Algorithm:
   * 1. Check validation cache for previous result
   * 2. If not cached, send validation request to background script
   * 3. Cache the result (both positive and negative) for future use
   * 4. Return the gateway URL or null
   *
   * Performance Optimization:
   * - LRU cache prevents redundant API calls
   * - Stores both valid and invalid results to avoid re-checking failures
   *
   * @param {string} ipfsPath - IPFS path to validate (e.g., "/ipfs/QmHash")
   * @returns {Promise<string|null>} Gateway URL if valid, null if invalid
   */
  async function validIpfsResource (ipfsPath) {
    // Check cache first - validation is expensive, so we cache all results
    if (window.ipfsCompanionLinkifyValidationCache.has(ipfsPath)) {
      return window.ipfsCompanionLinkifyValidationCache.get(ipfsPath)
    }

    try {
      // Request validation from background script
      // Background script has access to IPFS node and can perform proper validation
      const validationResult = await browser.runtime.sendMessage({
        pubGwUrlForIpfsOrIpnsPath: ipfsPath
      })

      // Cache the valid gateway URL
      window.ipfsCompanionLinkifyValidationCache.set(
        ipfsPath,
        validationResult.pubGwUrlForIpfsOrIpnsPath
      )
    } catch (error) {
      // Cache negative results to avoid repeated failed validations
      window.ipfsCompanionLinkifyValidationCache.set(ipfsPath, null)
      console.error('IPFS path validation error for ' + ipfsPath, error)
    }

    return window.ipfsCompanionLinkifyValidationCache.get(ipfsPath)
  }

  /**
   * Check if a text node is in a safe location for linkification
   *
   * Performs safety checks to prevent linkification in inappropriate contexts:
   * - Editable content (forms, contentEditable elements)
   * - Already linkified content (prevents double-processing)
   * - Styled <pre> elements (often syntax-highlighted code)
   * - Nodes no longer in visible DOM
   *
   * Algorithm:
   * 1. Check if node has a parent (still in DOM)
   * 2. Walk up parent tree checking each ancestor
   * 3. Apply safety filters at each level
   * 4. Return false if any unsafe condition found
   *
   * Safety Filters:
   * - isContentEditable: User editable content
   * - linkifiedIpfsAddress class: Already processed content
   * - <pre> with className: Often syntax highlighted code
   * - Disconnected nodes: No longer in visible DOM
   *
   * @param {Text} node - Text node to check for safety
   * @returns {boolean} True if safe to linkify, false otherwise
   */
  function isParentTreeSafe (node) {
    let currentParent = node.parentNode

    // Early exit if node is disconnected from DOM
    if (!currentParent) {
      return false
    }

    // Walk up the parent tree checking each ancestor
    while (currentParent) {
      // Skip editable content - users expect their input to remain unchanged
      if (currentParent.isContentEditable) {
        return false
      }

      // Skip already linkified content - prevents infinite recursion and duplicate processing
      if (currentParent.className &&
          currentParent.className.match(/\blinkifiedIpfsAddress\b/)) {
        return false
      }

      // Skip styled <pre> elements - often contain syntax-highlighted code
      // where linkification would break highlighting
      if (currentParent.tagName === 'PRE' && currentParent.className) {
        return false
      }

      // Ensure node is still connected to visible DOM
      // Handles edge case where DOM is modified during processing
      if (!(currentParent instanceof HTMLDocument) && !currentParent.parentNode) {
        return false
      }

      // Move up to next parent
      currentParent = currentParent.parentNode
    }

    return true
  }

  /**
   * Convert IPFS/IPNS patterns in a text node to clickable links
   *
   * This is the core linkification function that processes individual text nodes.
   * It scans text content for IPFS patterns and replaces them with proper HTML links.
   *
   * Algorithm:
   * 1. Validate text node safety (editable content, DOM position, etc.)
   * 2. Scan text content using regex to find IPFS patterns
   * 3. For each match:
   *    a. Validate the IPFS resource
   *    b. Create link element if valid
   *    c. Build replacement span with mixed text and links
   * 4. Replace original text node with new span containing links
   *
   * Performance Considerations:
   * - Early safety check prevents unnecessary processing
   * - Lazy span creation (only when first link found)
   * - Efficient text manipulation using substring operations
   * - Error handling prevents DOM corruption
   *
   * DOM Structure Created:
   * Original: "Check out /ipfs/QmHash for details"
   * Result:   <span class="linkifiedIpfsAddress">
   *             "Check out "
   *             <a href="gateway-url" class="linkifiedIpfsAddress">/ipfs/QmHash</a>
   *             " for details"
   *           </span>
   *
   * @param {Text} textNode - Text node to process for IPFS patterns
   */
  async function linkifyTextNode (textNode) {
    // Safety check - skip if node is in unsafe context
    if (!isParentTreeSafe(textNode)) {
      return
    }

    // Initialize processing variables
    let gatewayUrl = null
    let regexMatch = null
    const originalText = textNode.textContent
    let containerSpan = null // Lazy initialization for performance
    let lastProcessedIndex = 0

    // Scan text content for IPFS patterns using global regex
    while ((regexMatch = urlRE.exec(originalText))) {
      // Validate the matched IPFS resource
      gatewayUrl = await textToIpfsResource(regexMatch)

      if (gatewayUrl) {
        // Create text node for the matched IPFS pattern
        const linkTextNode = document.createTextNode(regexMatch[0])

        // Lazy initialization of container span (performance optimization)
        if (containerSpan === null) {
          containerSpan = document.createElement('span')
          containerSpan.className = 'linkifiedIpfsAddress'
        }

        // Add text content before the current match
        const preMatchText = originalText.substring(lastProcessedIndex, regexMatch.index)
        containerSpan.appendChild(document.createTextNode(preMatchText))

        // Create and configure the link element
        const linkElement = document.createElement('a')
        linkElement.className = 'linkifiedIpfsAddress'
        linkElement.setAttribute('href', gatewayUrl)
        linkElement.appendChild(linkTextNode)
        containerSpan.appendChild(linkElement)

        // Update processing position
        const matchLength = regexMatch[0].length
        lastProcessedIndex = regexMatch.index + matchLength
      }
    }

    // Replace original text node with linkified content if any links were created
    if (containerSpan && textNode.parentNode) {
      try {
        // Add remaining text after the last match
        const remainingText = originalText.substring(lastProcessedIndex, originalText.length)
        containerSpan.appendChild(document.createTextNode(remainingText))

        // Atomically replace the original text node
        textNode.parentNode.replaceChild(containerSpan, textNode)
      } catch (error) {
        // Error handling prevents DOM corruption in edge cases
        console.error('Error during text node replacement:', error)
      }
    }
  }

  // Initialize the linkification system
  init()
}(window.ipfsCompanionLinkifiedDOM))
