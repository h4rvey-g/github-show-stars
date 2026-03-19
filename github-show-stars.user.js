// ==UserScript==
// @name         GitHub Show Stars
// @namespace    https://github.com/h4rvey-g/github-show-stars
// @version      1.0.0
// @description  Show star counts after every GitHub repo link on all webpages
// @author       h4rvey-g
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.github.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/h4rvey-g/github-show-stars/master/github-show-stars.user.js
// @downloadURL  https://raw.githubusercontent.com/h4rvey-g/github-show-stars/master/github-show-stars.user.js
// ==/UserScript==

(function () {
    'use strict';

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    /**
     * Optional GitHub Personal Access Token.
     * Set via Tampermonkey storage to raise the API rate limit from 60 to 5000
     * requests/hour.  Never hard-code your token here.
     *
     * To set the token run the following one-time snippet in the browser console
     * while the userscript is installed:
     *   GM_setValue('github_token', 'ghp_yourTokenHere');
     */
    const GITHUB_TOKEN = GM_getValue('github_token', '');

    /** How long (ms) to keep a cached star-count before re-fetching. */
    const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

    /** Attribute added to links that have already been processed. */
    const PROCESSED_ATTR = 'data-gss-processed';

    /** Class name used on injected star badges. */
    const BADGE_CLASS = 'gss-star-badge';

    // -------------------------------------------------------------------------
    // In-memory cache  { "owner/repo": { stars: Number, pushedAt: String, createdAt: String, ts: Number } }
    // -------------------------------------------------------------------------
    const cache = {};

    // -------------------------------------------------------------------------
    // Inject stylesheet once
    // -------------------------------------------------------------------------
    (function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .${BADGE_CLASS} {
                display: inline-flex;
                align-items: center;
                gap: 2px;
                margin-left: 4px;
                padding: 1px 5px;
                border-radius: 10px;
                font-size: 0.78em;
                font-weight: 600;
                line-height: 1.5;
                vertical-align: middle;
                white-space: nowrap;
                background: #f1f8ff;
                color: #0969da;
                border: 1px solid #d0e4f7;
                text-decoration: none !important;
                cursor: default;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
            }
            .${BADGE_CLASS}:hover {
                background: #dbeafe;
            }
            .${BADGE_CLASS}--loading {
                color: #8b949e;
                border-color: #d0d7de;
                background: #f6f8fa;
            }
            .${BADGE_CLASS}--error {
                color: #cf222e;
                border-color: #f8d7da;
                background: #fff0f0;
            }
        `;
        document.head.appendChild(style);
    })();

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Format a date string as a human-readable relative time.
     * e.g.  "just now"  |  "5 minutes ago"  |  "3 hours ago"  |  "2 days ago"
     *       "4 months ago"  |  "2 years ago"
     */
    function timeAgo(dateString) {
        const seconds = Math.floor((Date.now() - new Date(dateString)) / 1000);
        if (seconds < 60) return 'just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
        const days = Math.floor(hours / 24);
        if (days <= 30) return `${days} day${days !== 1 ? 's' : ''} ago`;
        const months = Math.floor(days / 30.44); // average days per month (365.25 / 12)
        if (months < 12) return `${months} month${months !== 1 ? 's' : ''} ago`;
        const years = Math.floor(days / 365.25);
        return `${years} year${years !== 1 ? 's' : ''} ago`;
    }

    /**
     * Format a raw star count into a compact human-readable string.
     * e.g.  42 → "42"  |  1234 → "1.2k"  |  23456 → "23.5k"  |  1234567 → "1.2M"
     */
    function formatStars(n) {
        if (n >= 1_000_000) {
            return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
        }
        if (n >= 1_000) {
            return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
        }
        return String(n);
    }

    /**
     * Extract "owner/repo" from a URL string.
     * Returns null if the URL does not point to a GitHub repository root.
     */
    function extractRepo(href) {
        try {
            const url = new URL(href);
            // Only handle github.com links
            if (url.hostname !== 'github.com') return null;

            // pathname = /owner/repo  (possibly with trailing slash)
            const parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
            if (parts.length !== 2) return null;

            const [owner, repo] = parts;
            // Exclude obviously non-repo paths (e.g. search, orgs, settings…)
            if (!owner || !repo) return null;
            // Ignore dotfiles / GitHub meta pages
            if (owner.startsWith('.') || repo.startsWith('.')) return null;

            return `${owner}/${repo}`;
        } catch {
            return null;
        }
    }

    /**
     * Fetch repo info for "owner/repo" via the GitHub REST API.
     * Returns a Promise<{ stars, pushedAt, createdAt }>.
     */
    function fetchRepoInfo(repoPath) {
        return new Promise((resolve, reject) => {
            const headers = {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            };
            if (GITHUB_TOKEN) {
                headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
            }

            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.github.com/repos/${repoPath}`,
                headers,
                onload(response) {
                    if (response.status === 200) {
                        try {
                            const data = JSON.parse(response.responseText);
                            resolve({
                                stars: data.stargazers_count,
                                pushedAt: data.pushed_at,
                                createdAt: data.created_at,
                            });
                        } catch {
                            reject(new Error('JSON parse error'));
                        }
                    } else {
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror() {
                    reject(new Error('Network error'));
                },
                ontimeout() {
                    reject(new Error('Timeout'));
                },
                timeout: 10000,
            });
        });
    }

    /**
     * Return the cached repo info if still fresh, or null otherwise.
     */
    function getCached(repoPath) {
        const entry = cache[repoPath];
        if (!entry) return null;
        if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
        return { stars: entry.stars, pushedAt: entry.pushedAt, createdAt: entry.createdAt };
    }

    /**
     * Store repo info in the cache.
     */
    function setCached(repoPath, info) {
        cache[repoPath] = { stars: info.stars, pushedAt: info.pushedAt, createdAt: info.createdAt, ts: Date.now() };
    }

    // In-flight promise map to deduplicate concurrent requests for the same repo
    const inFlight = {};

    /**
     * Get repo info for a repo, using cache and deduplication.
     */
    function getRepoInfo(repoPath) {
        const cached = getCached(repoPath);
        if (cached !== null) return Promise.resolve(cached);

        if (inFlight[repoPath]) return inFlight[repoPath];

        const promise = fetchRepoInfo(repoPath)
            .then((info) => {
                setCached(repoPath, info);
                delete inFlight[repoPath];
                return info;
            })
            .catch((err) => {
                delete inFlight[repoPath];
                throw err;
            });

        inFlight[repoPath] = promise;
        return promise;
    }

    // -------------------------------------------------------------------------
    // Badge rendering
    // -------------------------------------------------------------------------

    /**
     * Create a loading-state badge element.
     */
    function createBadge() {
        const badge = document.createElement('span');
        badge.className = `${BADGE_CLASS} ${BADGE_CLASS}--loading`;
        badge.setAttribute('aria-label', 'Loading star count');
        badge.textContent = '⭐ …';
        return badge;
    }

    /**
     * Update badge once we have the repo info (or an error).
     */
    function updateBadge(badge, repoPath, info) {
        badge.classList.remove(`${BADGE_CLASS}--loading`, `${BADGE_CLASS}--error`);
        badge.setAttribute('aria-label', `${info.stars} stars on GitHub`);
        let tooltip = `${info.stars.toLocaleString()} stars — ${repoPath}`;
        if (info.pushedAt) tooltip += `\nLast commit: ${timeAgo(info.pushedAt)}`;
        if (info.createdAt) tooltip += `\nCreated: ${timeAgo(info.createdAt)}`;
        badge.title = tooltip;
        badge.textContent = `⭐ ${formatStars(info.stars)}`;
    }

    function setBadgeError(badge, repoPath, err) {
        badge.classList.remove(`${BADGE_CLASS}--loading`);
        badge.classList.add(`${BADGE_CLASS}--error`);
        badge.setAttribute('aria-label', 'Could not load star count');
        badge.title = `Could not load stars for ${repoPath}: ${err.message}`;
        badge.textContent = '⭐ ?';
    }

    // -------------------------------------------------------------------------
    // Link processing
    // -------------------------------------------------------------------------

    /**
     * Process a single anchor element: extract the repo, create a badge, and
     * start the async fetch.
     */
    function processLink(anchor) {
        if (anchor.hasAttribute(PROCESSED_ATTR)) return;
        anchor.setAttribute(PROCESSED_ATTR, '1');

        const repoPath = extractRepo(anchor.href);
        if (!repoPath) return;

        const badge = createBadge();
        anchor.insertAdjacentElement('afterend', badge);

        getRepoInfo(repoPath)
            .then((info) => updateBadge(badge, repoPath, info))
            .catch((err) => setBadgeError(badge, repoPath, err));
    }

    /**
     * Scan a subtree for unprocessed GitHub repo links.
     */
    function processLinks(root) {
        const anchors = root.querySelectorAll
            ? root.querySelectorAll(`a[href*="github.com"]:not([${PROCESSED_ATTR}])`)
            : [];
        anchors.forEach(processLink);
    }

    // -------------------------------------------------------------------------
    // MutationObserver – handle dynamically added content (SPAs, infinite scroll)
    // -------------------------------------------------------------------------
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                // Check the node itself
                if (node.tagName === 'A') processLink(node);
                // Check descendants
                processLinks(node);
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Initial scan of the already-loaded DOM
    processLinks(document);
})();
