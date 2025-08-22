'use strict'

import browser from 'webextension-polyfill'
import { findValueForContext } from './context-menus.js'

/**
 * IPFS Companion Clipboard Operations
 *
 * This module provides secure and cross-platform clipboard functionality for IPFS addresses
 * and URLs. It handles browser differences and security restrictions while providing
 * user-friendly notifications.
 *
 * Core Functionality:
 * 1. Secure clipboard write operations with fallback mechanisms
 * 2. IPFS path validation and conversion for different formats
 * 3. Gateway URL generation for public access
 * 4. Context-aware copying (selection, page, tab contexts)
 * 5. User notification system for operation feedback
 *
 * Browser Compatibility:
 * - Firefox: Uses navigator.clipboard API directly
 * - Chromium: Uses scripting API for MV3 compatibility
 * - Fallback: Content script injection for older browsers
 *
 * Security Considerations:
 * - Clipboard access requires user permissions
 * - Content Security Policy restrictions handled
 * - Active tab requirement for secure operations
 *
 * @author IPFS Companion Team
 * @license CC0-1.0
 */

/**
 * Low-level clipboard write operation with permission handling
 *
 * Attempts to write text to clipboard using the modern Clipboard API.
 * Handles permission denials gracefully without unnecessary error logging.
 *
 * Algorithm:
 * 1. Attempt clipboard write using navigator.clipboard.writeText
 * 2. Handle permission errors silently (expected in some contexts)
 * 3. Return success/failure status for caller handling
 *
 * @param {string} text - Text content to write to clipboard
 * @returns {Promise<boolean>} True if successful, false if failed/denied
 */
async function writeToClipboard (text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (error) {
    // Permission denial or CSP restrictions are expected in some contexts
    // No logging required as this is handled gracefully by calling functions
    return false
  }
}

/**
 * Retrieve the currently active browser tab
 *
 * Uses browser.tabs API to identify the user's current focus context.
 * Essential for tab-specific operations and scripting permissions.
 *
 * Query Strategy:
 * - active: true - Only currently active tab
 * - lastFocusedWindow: true - From the focused window
 *
 * @returns {Promise<tabs.Tab|undefined>} Active tab object or undefined if not found
 */
async function getCurrentTab () {
  const tabQueryOptions = { active: true, lastFocusedWindow: true }
  const [activeTab] = await browser.tabs.query(tabQueryOptions)
  return activeTab
}

/**
 * Manifest V3 compatible clipboard operation via content script execution
 *
 * This function provides clipboard access in Manifest V3 service workers where
 * the Clipboard API is not directly available. Uses scripting API to execute
 * clipboard operations in the active tab context.
 *
 * Required Permissions:
 * - "scripting" - For executeScript functionality
 * - "activeTab" - For tab access without broad host permissions
 *
 * Algorithm:
 * 1. Get current active tab for execution context
 * 2. Execute writeToClipboard function in tab context
 * 3. Validate operation result and handle errors
 *
 * Browser Support:
 * - Chrome/Chromium: Primary use case
 * - Firefox: Fallback (though direct API preferred)
 * - Safari: Future compatibility
 *
 * @param {string} text - Text content to copy to clipboard
 * @throws {Error} If tab access fails or clipboard operation fails
 */
async function copyTextToClipboardFromCurrentTab (text) {
  const currentTab = await getCurrentTab()
  if (!currentTab) {
    throw new Error('Unable to access current tab for clipboard operation')
  }

  // Execute clipboard operation in tab context for MV3 compatibility
  const [executionResult] = await browser.scripting.executeScript({
    target: { tabId: currentTab.id },
    func: writeToClipboard,
    args: [text]
  })

  if (!executionResult.result) {
    throw new Error('Clipboard write operation failed or was denied')
  }
}

/**
 * High-level clipboard operation with user notification
 *
 * Provides a unified interface for clipboard operations across different browsers
 * and execution contexts. Handles fallbacks and user feedback automatically.
 *
 * Algorithm:
 * 1. Detect browser capabilities (Clipboard API vs scripting required)
 * 2. Attempt clipboard operation using appropriate method
 * 3. Provide user feedback via notification system
 * 4. Handle errors gracefully with descriptive messages
 *
 * Browser Detection:
 * - Firefox: navigator.clipboard available, use direct API
 * - Chromium: May require content script execution for MV3
 *
 * @param {string} text - Text content to copy
 * @param {Function} notify - Notification function for user feedback
 */
async function copyTextToClipboard (text, notify) {
  try {
    if (typeof navigator.clipboard !== 'undefined') {
      // Modern browsers with direct Clipboard API access
      await writeToClipboard(text)
    } else {
      // Manifest V3 or restricted contexts requiring content script
      await copyTextToClipboardFromCurrentTab(text)
    }

    // Success notification with copied content preview
    notify('notify_copiedTitle', text)
  } catch (error) {
    // Error handling with user-friendly messaging
    console.error('[ipfs-companion] Clipboard operation failed:', error)
    notify('notify_addonIssueTitle', 'Unable to copy content to clipboard')
  }
}

/**
 * Creates a comprehensive IPFS address copying service
 *
 * Factory function that returns a service object with methods for copying
 * various IPFS address formats. Each method handles context resolution,
 * path validation, and format conversion automatically.
 *
 * Supported Copy Operations:
 * 1. Canonical IPFS paths (/ipfs/..., /ipns/...)
 * 2. Immutable CID addresses (content-addressed)
 * 3. Raw CID extraction (just the hash)
 * 4. Public gateway URLs (publicly accessible)
 * 5. Permalinks (permanent IPFS addresses)
 * 6. Raw text content (direct clipboard operations)
 *
 * Context Handling:
 * - Automatically resolves URLs from various contexts (selection, page, tab)
 * - Validates IPFS paths before copying
 * - Provides appropriate error handling for each operation type
 *
 * @param {Function} notify - Notification service for user feedback
 * @param {Object} ipfsPathValidator - IPFS path validation and conversion service
 * @returns {Object} Copier service with methods for each copy operation
 */
export default function createCopier (notify, ipfsPathValidator) {
  return {
    /**
     * Copy plain text directly to clipboard
     *
     * Simple text copying operation without IPFS-specific processing.
     * Useful for arbitrary text content or pre-formatted addresses.
     *
     * @param {string} text - Text content to copy
     */
    async copyTextToClipboard (text) {
      await copyTextToClipboard(text, notify)
    },

    /**
     * Copy canonical IPFS path from context
     *
     * Extracts URL from provided context and converts to canonical IPFS path format.
     * Handles both /ipfs/ and /ipns/ paths with full validation.
     *
     * Examples:
     * - https://gateway.com/ipfs/QmHash → /ipfs/QmHash
     * - https://example.com/path → /ipns/example.com/path (if DNSLink)
     *
     * @param {*} context - Context object (selection, page, etc.)
     * @param {string} contextType - Type of context for resolution
     */
    async copyCanonicalAddress (context, contextType) {
      const sourceUrl = await findValueForContext(context, contextType)
      const canonicalIpfsPath = ipfsPathValidator.resolveToIpfsPath(sourceUrl)
      await copyTextToClipboard(canonicalIpfsPath, notify)
    },

    /**
     * Copy immutable CID-based IPFS path from context
     *
     * Converts mutable IPNS paths to immutable IPFS paths by resolving
     * the underlying content address. Ensures copied address is permanent.
     *
     * Examples:
     * - /ipns/example.com → /ipfs/QmResolvedHash
     * - /ipfs/QmHash → /ipfs/QmHash (already immutable)
     *
     * @param {*} context - Context object for URL extraction
     * @param {string} contextType - Context type for resolution strategy
     */
    async copyCidAddress (context, contextType) {
      const sourceUrl = await findValueForContext(context, contextType)
      const immutableIpfsPath = await ipfsPathValidator.resolveToImmutableIpfsPath(sourceUrl)
      await copyTextToClipboard(immutableIpfsPath, notify)
    },

    /**
     * Copy raw CID (content identifier) from context
     *
     * Extracts just the CID hash without path prefix, suitable for
     * programmatic use or direct IPFS operations.
     *
     * Special Handling:
     * - HAMT-sharded directories: Limited support, user-friendly error
     * - Invalid paths: Descriptive error messages
     * - Network errors: Graceful fallback
     *
     * Examples:
     * - /ipfs/QmHash/file.txt → QmHash
     * - https://gateway.com/ipfs/QmHash → QmHash
     *
     * @param {*} context - Context object for URL extraction
     * @param {string} contextType - Context resolution strategy
     */
    async copyRawCid (context, contextType) {
      const sourceUrl = await findValueForContext(context, contextType)

      try {
        const extractedCid = await ipfsPathValidator.resolveToCid(sourceUrl)
        await copyTextToClipboard(extractedCid, notify)
      } catch (error) {
        console.error('CID resolution failed:', error.message)

        if (notify) {
          const errorMessage = error.toString()

          if (errorMessage.startsWith('Error: no link')) {
            // Special case: HAMT-sharded directory limitations
            // See: https://github.com/ipfs/js-ipfs/issues/1279
            // See: https://github.com/ipfs/go-ipfs/issues/5270
            notify('notify_addonIssueTitle',
              'Unable to resolve CID within HAMT-sharded directory. This limitation will be addressed in future updates.')
          } else {
            // Generic error with details
            notify('notify_addonIssueTitle', 'notify_inlineErrorMsg', error.message)
          }
        }
      }
    },

    /**
     * Copy public gateway URL from context
     *
     * Converts any IPFS address to a publicly accessible HTTP URL
     * using the configured public gateway. Ensures wide compatibility.
     *
     * Examples:
     * - /ipfs/QmHash → https://gateway.ipfs.io/ipfs/QmHash
     * - /ipns/example.com → https://gateway.ipfs.io/ipns/example.com
     *
     * @param {*} context - Context object for URL extraction
     * @param {string} contextType - Context resolution strategy
     */
    async copyAddressAtPublicGw (context, contextType) {
      const sourceUrl = await findValueForContext(context, contextType)
      const publicGatewayUrl = await ipfsPathValidator.resolveToPublicUrl(sourceUrl)
      await copyTextToClipboard(publicGatewayUrl, notify)
    },

    /**
     * Copy permalink (permanent IPFS address) from context
     *
     * Generates a permanent, immutable address that will always point
     * to the same content. Resolves IPNS to IPFS for permanence.
     *
     * Use Cases:
     * - Academic citations requiring permanent references
     * - Archival links that must remain valid indefinitely
     * - Content verification and integrity checking
     *
     * @param {*} context - Context object for URL extraction
     * @param {string} contextType - Context resolution strategy
     */
    async copyPermalink (context, contextType) {
      const sourceUrl = await findValueForContext(context, contextType)
      const permanentAddress = await ipfsPathValidator.resolveToPermalink(sourceUrl)
      await copyTextToClipboard(permanentAddress, notify)
    }
  }
}
