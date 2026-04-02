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
// @grant        GM_registerMenuCommand
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
    let GITHUB_TOKEN = GM_getValue('github_token', '');

    // -------------------------------------------------------------------------
    // Menu command – let the user set / clear the GitHub token from the
    // Tampermonkey extension menu without touching the browser console.
    // -------------------------------------------------------------------------
    GM_registerMenuCommand('Set GitHub Token', () => {
        const current = GM_getValue('github_token', '');
        const input = prompt(
            'Enter your GitHub Personal Access Token.\n' +
            'Leave blank and click OK to clear the stored token.\n\n' +
            (current ? 'A token is currently set.' : 'No token is currently set.'),
            current
        );
        // prompt() returns null when the user clicks Cancel – do nothing.
        if (input === null) return;

        const trimmed = input.trim();
        GM_setValue('github_token', trimmed);
        GITHUB_TOKEN = trimmed;
        if (trimmed) {
            alert('GitHub token saved. Reload the page to apply the new token.');
        } else {
            alert('GitHub token cleared. Reload the page to apply the change.');
        }
    });

    /** How long (ms) to keep a cached star-count before re-fetching. */
    const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

    /** Attribute added to links that have already been processed. */
    const PROCESSED_ATTR = 'data-gss-processed';

    /** Substring that must appear in an href for the CSS pre-filter to match. */
    const GITHUB_HREF_FILTER = '://github.com/';

    /**
     * GitHub top-level routes that are not repository owners.
     * This keeps us from treating pages like /settings/tokens as repos.
     */
    const RESERVED_TOP_LEVEL_PATHS = new Set([
        'about',
        'account',
        'apps',
        'blog',
        'collections',
        'contact',
        'customer-stories',
        'enterprise',
        'events',
        'explore',
        'features',
        'gist',
        'git-guides',
        'github-copilot',
        'issues',
        'login',
        'logout',
        'marketplace',
        'mobile',
        'new',
        'notifications',
        'orgs',
        'organizations',
        'pricing',
        'pulls',
        'readme',
        'search',
        'security',
        'settings',
        'signup',
        'site',
        'sponsors',
        'team',
        'teams',
        'topics',
        'trending',
    ]);

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
            @media (prefers-color-scheme: dark) {
                .${BADGE_CLASS} {
                    background: #1c2d40;
                    color: #58a6ff;
                    border-color: #1f4068;
                }
                .${BADGE_CLASS}:hover {
                    background: #1f3a5c;
                }
                .${BADGE_CLASS}--loading {
                    color: #8b949e;
                    border-color: #30363d;
                    background: #161b22;
                }
                .${BADGE_CLASS}--error {
                    color: #ff7b72;
                    border-color: #6e2f2f;
                    background: #3d1414;
                }
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
     * Extract "owner/repo" from a GitHub repository URL.
     * Returns null unless the URL is the repository root itself
     * (e.g. https://github.com/owner/repo or /owner/repo/).
     */
    function extractRepo(href) {
        try {
            const url = new URL(href);
            // Only handle github.com links
            if (url.hostname !== 'github.com') return null;

            const parts = url.pathname.split('/').filter(Boolean);
            if (parts.length !== 2) return null;

            const [owner, repo] = parts;
            if (!owner || !repo) return null;
            if (owner.startsWith('.') || repo.startsWith('.')) return null;
            if (RESERVED_TOP_LEVEL_PATHS.has(owner.toLowerCase())) return null;
            if (repo === 'repositories') return null;

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
    // Batch-on-scroll loading
    // -------------------------------------------------------------------------

    /** Number of repositories fetched per scroll-triggered batch. */
    const FETCH_BATCH_SIZE = 30;

    /** Ordered list of discovered repo entries. */
    const repoEntries = [];

    /** Batch indexes that are allowed to start fetching. */
    const unlockedBatches = new Set([0]);

    /** Intersection observer used to unlock a batch when user scrolls to it. */
    const batchUnlockObserver = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const batchIndex = Number(entry.target.getAttribute('data-gss-batch-index'));
                if (!Number.isNaN(batchIndex)) {
                    unlockBatch(batchIndex);
                }
            }
        }, { root: null, rootMargin: '0px', threshold: 0.01 })
        : null;

    function unlockBatch(batchIndex) {
        if (unlockedBatches.has(batchIndex)) return;
        unlockedBatches.add(batchIndex);
        processUnlockedEntries();
    }

    function processUnlockedEntries() {
        for (const entry of repoEntries) {
            if (entry.fetchStarted) continue;
            if (!unlockedBatches.has(entry.batchIndex)) continue;
            entry.fetchStarted = true;
            entry.badge.title = `Loading stars for ${entry.repoPath}`;

            getRepoInfo(entry.repoPath)
                .then((info) => updateBadge(entry.badge, entry.repoPath, info))
                .catch((err) => setBadgeError(entry.badge, entry.repoPath, err));
        }
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

        const batchIndex = Math.floor(repoEntries.length / FETCH_BATCH_SIZE);
        anchor.setAttribute('data-gss-batch-index', String(batchIndex));
        repoEntries.push({ anchor, badge, repoPath, batchIndex, fetchStarted: false });

        if (batchUnlockObserver) {
            batchUnlockObserver.observe(anchor);
        } else {
            // Fallback for very old browsers: no viewport signal, unlock all.
            unlockedBatches.add(batchIndex);
        }

        processUnlockedEntries();
    }

    // -------------------------------------------------------------------------
    // Idle-callback scheduler – process links in small chunks to avoid long
    // synchronous tasks (>50 ms) that trigger GitHub's long-task analytics
    // observer, which then tries to POST to collector.github.com and gets
    // blocked by ad-blockers (ERR_BLOCKED_BY_CLIENT).
    // -------------------------------------------------------------------------

    /** Maximum number of anchors to process per idle slice. */
    const BATCH_SIZE = 20;

    /** Pending anchor queue fed by the MutationObserver and initial scan. */
    const pendingAnchors = [];
    let idleCallbackScheduled = false;

    const scheduleIdle = typeof requestIdleCallback === 'function'
        ? (cb) => requestIdleCallback(cb, { timeout: 2000 })
        : (cb) => setTimeout(cb, 0);

    function flushPending(deadline) {
        const hasTime = () => deadline && typeof deadline.timeRemaining === 'function'
            ? deadline.timeRemaining() > 0
            : true;

        while (pendingAnchors.length > 0 && hasTime()) {
            const batch = pendingAnchors.splice(0, BATCH_SIZE);
            batch.forEach(processLink);
        }

        if (pendingAnchors.length > 0) {
            scheduleIdle(flushPending);
        } else {
            idleCallbackScheduled = false;
        }
    }

    function enqueueLinks(root) {
        const anchors = root.querySelectorAll
            ? root.querySelectorAll(`a[href*="${GITHUB_HREF_FILTER}"]:not([${PROCESSED_ATTR}])`)
            : [];
        anchors.forEach((a) => pendingAnchors.push(a));
        if (!idleCallbackScheduled && pendingAnchors.length > 0) {
            idleCallbackScheduled = true;
            scheduleIdle(flushPending);
        }
    }

    // -------------------------------------------------------------------------
    // MutationObserver – handle dynamically added content (SPAs, infinite scroll)
    // -------------------------------------------------------------------------
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                // Check the node itself
                if (node.tagName === 'A' && extractRepo(node.href)) pendingAnchors.push(node);
                // Check descendants
                enqueueLinks(node);
            }
        }
        if (!idleCallbackScheduled && pendingAnchors.length > 0) {
            idleCallbackScheduled = true;
            scheduleIdle(flushPending);
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Initial scan of the already-loaded DOM (batched to avoid long tasks)
    enqueueLinks(document);
})();
