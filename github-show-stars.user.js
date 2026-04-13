// ==UserScript==
// @name         GitHub Show Stars
// @namespace    https://github.com/h4rvey-g/github-show-stars
// @version      1.2.2
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

    /** Keyword used to identify awesome repositories. */
    const AWESOME_KEYWORD = 'awesome';

    /**
     * Extract "owner/repo" from a GitHub pathname.
     * When allowSubpaths is true, additional path segments are allowed after the
     * repository name (e.g. /owner/repo/issues/1).
     */
    function extractGitHubRepoPath(pathname, { allowSubpaths = false } = {}) {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length < 2) return null;
        if (!allowSubpaths && parts.length !== 2) return null;

        const [owner, repo] = parts;
        if (!owner || !repo) return null;
        if (owner.startsWith('.') || repo.startsWith('.')) return null;
        if (RESERVED_TOP_LEVEL_PATHS.has(owner.toLowerCase())) return null;
        if (repo === 'repositories') return null;

        return `${owner}/${repo}`;
    }

    /** Current GitHub repository page, if the current page is inside a repo. */
    const CURRENT_PAGE_REPO = window.location.hostname === 'github.com'
        ? extractGitHubRepoPath(window.location.pathname, { allowSubpaths: true })
        : null;

    /**
     * The floating sorting panel is only enabled on GitHub repository pages
     * whose own repository path contains "awesome".
     */
    const AWESOME_FEATURE_ENABLED = Boolean(
        CURRENT_PAGE_REPO && CURRENT_PAGE_REPO.toLowerCase().includes(AWESOME_KEYWORD)
    );

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
            .gss-awesome-panel {
                position: fixed;
                width: 320px;
                max-height: min(55vh, 460px);
                overflow: hidden;
                display: flex;
                flex-direction: column;
                border-radius: 12px;
                border: 1px solid #d0d7de;
                background: #ffffff;
                box-shadow: 0 10px 30px rgba(31, 35, 40, 0.15);
                z-index: 2147483647;
                contain: layout paint;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
            }
            .gss-awesome-panel__header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 10px 12px;
                border-bottom: 1px solid #d8dee4;
                font-size: 13px;
                font-weight: 700;
                color: #24292f;
                background: #f6f8fa;
                cursor: move;
                user-select: none;
            }
            .gss-awesome-panel__count {
                font-size: 12px;
                font-weight: 600;
                color: #57606a;
            }
            .gss-awesome-panel__body {
                overflow: auto;
                padding: 6px 8px;
            }
            .gss-awesome-panel__empty {
                margin: 8px 4px;
                padding: 10px;
                border-radius: 8px;
                font-size: 12px;
                color: #57606a;
                background: #f6f8fa;
                border: 1px dashed #d0d7de;
            }
            .gss-awesome-item {
                display: flex;
                align-items: baseline;
                justify-content: space-between;
                gap: 10px;
                padding: 6px 8px;
                margin: 2px 0;
                border-radius: 8px;
                text-decoration: none;
                color: inherit;
            }
            .gss-awesome-item:hover {
                background: #eaeef2;
            }
            .gss-awesome-item__repo {
                font-size: 12px;
                color: #0969da;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .gss-awesome-item__stars {
                font-size: 12px;
                font-weight: 700;
                color: #24292f;
                white-space: nowrap;
            }
            @media (prefers-color-scheme: dark) {
                .gss-awesome-panel {
                    border-color: #30363d;
                    background: #161b22;
                    box-shadow: 0 10px 30px rgba(1, 4, 9, 0.45);
                }
                .gss-awesome-panel__header {
                    color: #f0f6fc;
                    background: #161b22;
                    border-bottom-color: #30363d;
                }
                .gss-awesome-panel__count,
                .gss-awesome-panel__empty {
                    color: #8b949e;
                }
                .gss-awesome-panel__empty {
                    border-color: #30363d;
                    background: #0d1117;
                }
                .gss-awesome-item:hover {
                    background: #21262d;
                }
                .gss-awesome-item__repo {
                    color: #58a6ff;
                }
                .gss-awesome-item__stars {
                    color: #c9d1d9;
                }
            }
        `;
        document.head.appendChild(style);
    })();

    // -------------------------------------------------------------------------
    // Linked repo floating panel for GitHub awesome repository pages
    // -------------------------------------------------------------------------
    const awesomeRepoMap = new Map();
    let awesomePanelBody = null;
    let awesomePanelCount = null;
    const PANEL_POSITION_KEY = 'awesome_panel_position_v1';
    const AWESOME_PANEL_RENDER_DELAY_MS = 120;
    let awesomePanelRenderTimer = null;

    function ensureAwesomePanel() {
        if (!AWESOME_FEATURE_ENABLED || awesomePanelBody) return;

        const panel = document.createElement('section');
        panel.className = 'gss-awesome-panel';
        panel.setAttribute('aria-label', 'Repositories linked from this awesome GitHub repository, sorted by stars');
        panel.innerHTML = `
            <div class="gss-awesome-panel__header">
                <span>Linked Repos ⭐</span>
                <span class="gss-awesome-panel__count">0</span>
            </div>
            <div class="gss-awesome-panel__body"></div>
        `;

        awesomePanelBody = panel.querySelector('.gss-awesome-panel__body');
        awesomePanelCount = panel.querySelector('.gss-awesome-panel__count');
        applyInitialPanelPosition(panel);
        bindPanelDrag(panel);
        document.body.appendChild(panel);
        renderAwesomePanel();
    }

    function applyPanelPosition(panel, left, top) {
        const maxLeft = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
        const maxTop = Math.max(8, window.innerHeight - panel.offsetHeight - 8);
        const safeLeft = Math.min(Math.max(8, left), maxLeft);
        const safeTop = Math.min(Math.max(8, top), maxTop);
        panel.style.left = `${safeLeft}px`;
        panel.style.top = `${safeTop}px`;
    }

    function getSavedPanelPosition() {
        const raw = GM_getValue(PANEL_POSITION_KEY, '');
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed?.left !== 'number' || typeof parsed?.top !== 'number') return null;
            return parsed;
        } catch {
            return null;
        }
    }

    function savePanelPosition(left, top) {
        GM_setValue(PANEL_POSITION_KEY, JSON.stringify({ left, top }));
    }

    function getSmartDefaultPosition(panel) {
        const margin = 16;
        const panelWidth = panel.offsetWidth;
        const panelHeight = panel.offsetHeight;
        const defaultPos = {
            left: window.innerWidth - panelWidth - margin,
            top: 88,
        };

        const readme = document.querySelector('#readme');
        if (!readme) return defaultPos;

        const rect = readme.getBoundingClientRect();
        const overlapsHorizontally = defaultPos.left < rect.right && defaultPos.left + panelWidth > rect.left;
        const overlapsVertically = defaultPos.top < rect.bottom && defaultPos.top + panelHeight > rect.top;
        if (!overlapsHorizontally || !overlapsVertically) return defaultPos;

        const rightSpace = window.innerWidth - rect.right;
        if (rightSpace >= panelWidth + margin) {
            return { left: rect.right + margin, top: Math.max(88, rect.top) };
        }

        const leftSpace = rect.left;
        if (leftSpace >= panelWidth + margin) {
            return { left: rect.left - panelWidth - margin, top: Math.max(88, rect.top) };
        }

        return defaultPos;
    }

    function applyInitialPanelPosition(panel) {
        panel.style.visibility = 'hidden';
        document.body.appendChild(panel);

        const saved = getSavedPanelPosition();
        if (saved) {
            applyPanelPosition(panel, saved.left, saved.top);
        } else {
            const pos = getSmartDefaultPosition(panel);
            applyPanelPosition(panel, pos.left, pos.top);
            savePanelPosition(pos.left, pos.top);
        }

        panel.remove();
        panel.style.visibility = '';
    }

    function bindPanelDrag(panel) {
        const header = panel.querySelector('.gss-awesome-panel__header');
        if (!header) return;

        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;
        let pointerId = null;

        const onPointerMove = (event) => {
            if (!dragging) return;
            const left = event.clientX - offsetX;
            const top = event.clientY - offsetY;
            applyPanelPosition(panel, left, top);
        };

        const onPointerUp = () => {
            if (!dragging) return;
            dragging = false;
            if (pointerId !== null) {
                header.releasePointerCapture?.(pointerId);
            }
            pointerId = null;
            const left = Number.parseFloat(panel.style.left) || 0;
            const top = Number.parseFloat(panel.style.top) || 0;
            savePanelPosition(left, top);
        };

        header.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            dragging = true;
            pointerId = event.pointerId;
            header.setPointerCapture?.(pointerId);
            const rect = panel.getBoundingClientRect();
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            event.preventDefault();
        });

        header.addEventListener('pointermove', onPointerMove);
        header.addEventListener('pointerup', onPointerUp);
        header.addEventListener('pointercancel', onPointerUp);

        window.addEventListener('resize', () => {
            const left = Number.parseFloat(panel.style.left) || 0;
            const top = Number.parseFloat(panel.style.top) || 0;
            applyPanelPosition(panel, left, top);
            savePanelPosition(
                Number.parseFloat(panel.style.left) || 0,
                Number.parseFloat(panel.style.top) || 0
            );
        });
    }

    function shouldTrackRepoInAwesomePanel(repoPath) {
        if (!AWESOME_FEATURE_ENABLED || !repoPath) return false;
        return repoPath.toLowerCase() !== CURRENT_PAGE_REPO.toLowerCase();
    }

    function scheduleAwesomePanelRender() {
        if (awesomePanelRenderTimer !== null) return;
        awesomePanelRenderTimer = window.setTimeout(() => {
            awesomePanelRenderTimer = null;
            renderAwesomePanel();
        }, AWESOME_PANEL_RENDER_DELAY_MS);
    }

    function upsertAwesomeRepo(repoPath, stars) {
        if (!shouldTrackRepoInAwesomePanel(repoPath)) return;
        if (awesomeRepoMap.get(repoPath) === stars) return;
        awesomeRepoMap.set(repoPath, stars);
        if (!awesomePanelBody || !awesomePanelCount) {
            ensureAwesomePanel();
            return;
        }
        awesomePanelCount.textContent = `${awesomeRepoMap.size}`;
        scheduleAwesomePanelRender();
    }

    function renderAwesomePanel() {
        if (!awesomePanelBody || !awesomePanelCount) return;

        const sortedEntries = Array.from(awesomeRepoMap.entries())
            .sort((a, b) => {
                if (b[1] !== a[1]) return b[1] - a[1];
                return a[0].localeCompare(b[0]);
            });

        awesomePanelCount.textContent = `${sortedEntries.length}`;
        if (sortedEntries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'gss-awesome-panel__empty';
            empty.textContent = 'No linked GitHub repositories have been loaded yet.';
            awesomePanelBody.replaceChildren(empty);
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const [repoPath, stars] of sortedEntries) {
            const item = document.createElement('a');
            item.className = 'gss-awesome-item';
            item.href = `https://github.com/${repoPath}`;
            item.target = '_blank';
            item.rel = 'noopener noreferrer';
            item.title = `${repoPath} • ${stars.toLocaleString()} stars`;
            item.innerHTML = `
                <span class="gss-awesome-item__repo">${repoPath}</span>
                <span class="gss-awesome-item__stars">⭐ ${formatStars(stars)}</span>
            `;
            fragment.appendChild(item);
        }
        awesomePanelBody.replaceChildren(fragment);
    }

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

            return extractGitHubRepoPath(url.pathname);
        } catch {
            return null;
        }
    }

    function isGitHubRepoChromeLink(anchor, repoPath) {
        if (window.location.hostname !== 'github.com') return false;
        if (!CURRENT_PAGE_REPO || !repoPath) return false;
        if (repoPath.toLowerCase() !== CURRENT_PAGE_REPO.toLowerCase()) return false;

        // Repository title breadcrumb/header link.
        if (anchor.closest('strong[itemprop="name"]')) return true;

        // GitHub repository navigation / toolbar links that point back to the
        // current repo root and should not get an extra star badge.
        if (anchor.id === 'code-tab' || anchor.id === 'code-view-repo-link') return true;
        if (anchor.closest('[data-menu-item="i0code-tab"]')) return true;

        return false;
    }

    function shouldSkipBadgeForAnchor(anchor, repoPath) {
        if (!anchor || !repoPath) return true;

        // Avoid recursively decorating our own floating panel items.
        if (anchor.closest('.gss-awesome-panel')) return true;

        // GitHub keeps some repo-root navigation links hidden in the DOM.
        // Adding badges after those invisible anchors makes the badge appear in
        // odd places around the toolbar.
        if (
            window.location.hostname === 'github.com' &&
            CURRENT_PAGE_REPO &&
            repoPath.toLowerCase() === CURRENT_PAGE_REPO.toLowerCase() &&
            anchor.closest('[hidden]')
        ) {
            return true;
        }

        return isGitHubRepoChromeLink(anchor, repoPath);
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
        upsertAwesomeRepo(repoPath, info.stars);
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

    function startRepoFetch(entry) {
        if (entry.fetchStarted) return;
        entry.fetchStarted = true;
        if (batchUnlockObserver) {
            batchUnlockObserver.unobserve(entry.anchor);
        }
        entry.badge.title = `Loading stars for ${entry.repoPath}`;

        getRepoInfo(entry.repoPath)
            .then((info) => updateBadge(entry.badge, entry.repoPath, info))
            .catch((err) => setBadgeError(entry.badge, entry.repoPath, err));
    }

    function processUnlockedEntries() {
        for (const entry of repoEntries) {
            if (!unlockedBatches.has(entry.batchIndex)) continue;
            startRepoFetch(entry);
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

        const repoPath = extractRepo(anchor.href);
        if (!repoPath || shouldSkipBadgeForAnchor(anchor, repoPath)) {
            anchor.setAttribute(PROCESSED_ATTR, '1');
            return;
        }

        anchor.setAttribute(PROCESSED_ATTR, '1');

        const badge = createBadge();
        anchor.insertAdjacentElement('afterend', badge);

        const batchIndex = Math.floor(repoEntries.length / FETCH_BATCH_SIZE);
        anchor.setAttribute('data-gss-batch-index', String(batchIndex));
        const entry = { anchor, badge, repoPath, batchIndex, fetchStarted: false };
        repoEntries.push(entry);

        if (AWESOME_FEATURE_ENABLED || unlockedBatches.has(batchIndex)) {
            startRepoFetch(entry);
        } else if (batchUnlockObserver) {
            batchUnlockObserver.observe(anchor);
        } else {
            // Fallback for very old browsers: no viewport signal, unlock all.
            unlockedBatches.add(batchIndex);
            startRepoFetch(entry);
        }
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
        const selector = window.location.hostname === 'github.com'
            ? `a[href*="${GITHUB_HREF_FILTER}"]:not([${PROCESSED_ATTR}]), a[href^="/"]:not([${PROCESSED_ATTR}])`
            : `a[href*="${GITHUB_HREF_FILTER}"]:not([${PROCESSED_ATTR}])`;
        const anchors = root.querySelectorAll
            ? root.querySelectorAll(selector)
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
