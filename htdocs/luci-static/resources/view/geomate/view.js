'use strict';
'require view';
'require uci';
'require ui';
'require rpc';
'require poll';
'require fs';
'require dom';

// Version and update channel information
const UI_VERSION = 'dev';
const UI_UPD_CHANNEL = 'release';

// Format version for display (shorten commit hashes to 8 characters)
function formatVersionDisplay(version) {
    if (!version) return version;
    
    // Check if it's a 40-character commit hash (only lowercase hex characters)
    if (/^[a-f0-9]{40}$/.test(version)) {
        // 40-char commit hash - show first 8 characters with ellipsis
        return version.substring(0, 8) + '...';
    }
    
    // Not a full commit hash - show as is
    return version;
}

// Region strings as the map writes them: circle:<lat>:<lon>:<radius in meters>
var REGION_RE = /^circle:-?\d{1,2}(\.\d+)?:-?\d{1,3}(\.\d+)?:[1-9]\d*$/;

// Same bounds as parseRegion in map.html, so the map can load every region the view writes
function validRegion(region) {
    var p = String(region || '').split(':');
    return REGION_RE.test(region || '') && Math.abs(p[1]) <= 90 && Math.abs(p[2]) <= 180;
}

// Filter names the backend supports in nft set and file names (filter_set_name in luci.geomate)
var FILTER_NAME_RE = /^[\w .-]+$/;

// Filter colors by section order, readable on the OSM tiles
var PALETTE = ['#0072B2', '#E69F00', '#CC79A7', '#009E73', '#D55E00', '#56B4E9', '#7F4FBF', '#8C6D31'];

// Key of 'New filter…' in the filter select of the new region dialog; no UCI section id contains '+'
var NEW_FILTER = '+new';

// Color of the filter at this position among the geo_filter sections; from the ninth filter on
// the palette repeats. The position alone decides, the name does not
function filterColor(index) {
    return PALETTE[index % PALETTE.length];
}

// The section id names a geo_filter section of the loaded configuration
function isGeoFilter(sid) {
    return !!sid && (uci.get('geomate', sid) || {})['.type'] === 'geo_filter';
}

function isEmpty(v) {
    return Array.isArray(v) ? v.length == 0 : (v == null || v === '');
}

// The staged geomate changes of a uci changes result, as JSON ('[]' for none)
function stagedKey(changes) {
    return JSON.stringify(L.toArray((changes || {}).geomate));
}

// Copy of the options of a section, without the '.' fields: what Undo writes back. null for no
// such section
function filterOptions(sid) {
    var s = sid ? uci.get('geomate', sid) : null, copy = {};

    if (!s)
        return null;
    Object.keys(s).forEach(function(k) {
        if (k.charAt(0) != '.')
            copy[k] = Array.isArray(s[k]) ? s[k].slice() : s[k];
    });
    return copy;
}

// The keys whose values differ between two filterOptions() results
function changedOptions(a, b) {
    return Object.keys(Object.assign({}, a, b)).filter(function(k) {
        return JSON.stringify(a[k]) !== JSON.stringify(b[k]);
    });
}

// Only the given keys of a filterOptions() result
function pick(o, keys) {
    var copy = {};

    keys.forEach(function(k) { copy[k] = o[k]; });
    return copy;
}

// An error whose text the map shows as it is (enqueue)
function failure(text) {
    var err = new Error(text);
    err.plain = true;
    return err;
}

// A map action whose filter id names another filter now (movedFilter)
function filtersChanged() {
    return failure(_('Not applied: the filters were changed in the meantime.'));
}

// The Enable button of a map toast (toastAction enableFilter)
function enableAction(sid) {
    return { name: 'enableFilter', sid: sid, label: _('Enable') };
}

// Suggested IP list path for a filter name
function ipListPath(name) {
    return '/etc/geomate.d/' + name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_servers.txt';
}

// mousedown handler of the <summary> bars: a click toggles the details without focusing the bar,
// so Chromium draws no focus ring that lingers until the focus moves on
function noFocus(ev) {
    ev.preventDefault();
}

// The message of an error without the stack trace, which L.raise() appends to RPC errors
function errorText(err) {
    return String((err && err.message) || err).split('\n')[0];
}

// Declare RPC methods to interact with the Geomate backend. reject: a ubus error (script crash or
// timeout, missing method, no permission) rejects instead of resolving to the expect default, so
// L.resolveDefault() gives null: the connection list stays as it was, the status shows "unknown".
// Whitelisted IPs reach the map through getGeomateConnections (is_allowed_ip): the map shows only
// IPs with an active connection. nobatch: a slow geo lookup never delays the status batch
var callGeomateConnections = rpc.declare({
    object: 'luci.geomate',
    method: 'getGeomateConnections',
    expect: { connections: [] },
    reject: true,
    nobatch: true
});

var callGetStatus = rpc.declare({
    object: 'luci.geomate',
    method: 'getStatus',
    expect: { status: {} },
    reject: true,
    filter: function(st) { return (typeof st.running == 'boolean') ? st : null; }
});

var callGetHealthCheck = rpc.declare({
    object: 'luci.geomate',
    method: 'getHealthCheck',
    expect: { health: {} },
    reject: true
});

// Staged changes of this session. Unlike uci.changes(), a ubus error rejects instead of
// resolving to {}, which would look like "nothing staged"
var callUciChanges = rpc.declare({
    object: 'uci',
    method: 'changes',
    expect: { changes: {} },
    reject: true
});

// Commits one configuration of this session; the luci-app-geomate ACL grants it for geomate.
// Unlike ui.changes.apply() it leaves the staged changes of other configurations alone and does
// not reload the page. rpcd then fires config.change, and procd runs geomate's reload trigger
var callUciCommit = rpc.declare({
    object: 'uci',
    method: 'commit',
    params: [ 'config' ],
    reject: true
});

// The map iframe sees none of the page's CSS, so the view sends it the theme colors. Candidate
// variables of Argon, Bootstrap and OpenWrt 2020, in this order; other themes get the fallbacks
var THEME_VARS = {
    accent: [ '--primary', '--primary-color-high', '--main-bright-color' ],
    danger: [ '--danger', '--red', '--error-color-high', '--danger-color' ],
    success: [ '--success', '--green', '--success-color-high', '--success-color' ]
};
var THEME_FALLBACKS = {
    light: { bg: 'rgb(255, 255, 255)', fg: 'rgb(31, 35, 40)', accent: 'rgb(26, 111, 209)', danger: 'rgb(207, 34, 46)', success: 'rgb(26, 127, 55)' },
    dark: { bg: 'rgb(30, 30, 30)', fg: 'rgb(230, 230, 230)', accent: 'rgb(76, 142, 218)', danger: 'rgb(248, 81, 73)', success: 'rgb(63, 185, 80)' }
};

// { r, g, b, a } of a computed color ('rgb(…)' or 'rgba(…)'), null for anything else
function parseRgb(color) {
    var m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,\/]\s*([\d.]+)(%?))?\s*\)$/.exec(color || '');
    if (!m)
        return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: (m[4] == null) ? 1 : m[5] ? m[4] / 100 : +m[4] };
}

function rgbString(c, alpha) {
    return (alpha == null) ? 'rgb(%d, %d, %d)'.format(c.r, c.g, c.b) : 'rgba(%d, %d, %d, %s)'.format(c.r, c.g, c.b, alpha);
}

// Relative luminance (WCAG): 0 for black, 1 for white
function luminance(c) {
    var channel = function(v) {
        v /= 255;
        return (v <= 0.03928) ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

// Text color on a background: dark text on light colors, white on dark ones
function textOn(color) {
    var c = parseRgb(color);
    return (c && luminance(c) > 0.4) ? 'rgb(31, 35, 40)' : 'rgb(255, 255, 255)';
}

// Status of a connection for the table: [ sort key, label ]
function connectionStatus(conn, geo) {
    if (conn.is_allowed_ip)
        return [ 'whitelist', _('Whitelisted') ];
    if (conn.allowed === true)
        return [ 'allowed', _('Allowed') ];
    if (!geo.lat || !geo.lon)
        return [ 'untracked', _('Untracked') ];
    if (conn.allowed === false)
        return [ 'blocked', _('Blocked') ];
    return [ 'unknown', _('Unknown') ];
}

// A table cell as an element: ui.Table puts a plain string in as HTML. Missing values show '–'
function textCell(value, title) {
    var text = (typeof value == 'string' && value !== '') ? value : '–';
    return E('span', (title && title !== text) ? { 'title': title } : {}, [ text ]);
}

// Poll intervals in seconds
var CONNECTIONS_INTERVAL = 5,
    STATUS_INTERVAL = 10,
    VERSION_INTERVAL = 3600,
    // Failed getGeomateConnections requests in a row before the status row says the list is old
    CONNECTIONS_STALE_AFTER = 3;

// check_version asks the GitHub API, which allows 60 unauthenticated requests per hour and public
// IP. The browser keeps the last result ({ stdout, stderr, code, at, ui }) and shows it again on page load
// and in the hourly poll: a success for VERSION_INTERVAL, a failure for VERSION_RETRY seconds
var VERSION_CACHE_KEY = 'geomate-version-check',
    VERSION_RETRY = 600;

// Symbols of the health check states in the status row
var CHECK_ICONS = { ok: '✓', info: '○', warning: '⚠', error: '✗' };

// { current, latest, channel } of one 'Backend versions:' or 'Frontend versions:' block
function versionFields(text) {
    var field = function(label) {
        var m = new RegExp(label + ': *(\\S+)').exec(text);
        return m ? m[1] : null;
    };
    return { current: field('Current version'), latest: field('Latest version'), channel: field('Update channel') };
}

/**
 * Versions and update state from a check_version result. The output has a 'Backend versions:'
 * block before 'Frontend versions:'; when GitHub fails it stops after the backend's channel and
 * current version. The frontend version then comes from this file (stamped by the updater).
 * The errors, 'HTTP error 403' among them, are on stderr.
 * @param {object} entry - { stdout, stderr, code } of check_version.
 * @returns {object} { backend, frontend, state: 'current'|'update'|'failed', update: 'both'|'backend'|'frontend'|null, limited }
 */
function versionState(entry) {
    var out = String(entry.stdout || ''),
        start = out.indexOf('Backend versions:'),
        at = out.indexOf('Frontend versions:'),
        b = versionFields((start < 0) ? '' : out.slice(start, (at > start) ? at : undefined)),
        f = versionFields((at < 0) ? '' : out.slice(at)),
        newer = function(c) { return !!(c.current && c.latest && c.current !== c.latest); };

    if (!f.current) {
        f.current = UI_VERSION;
        f.channel = f.channel || UI_UPD_CHANNEL;
    }

    return {
        backend: b,
        frontend: f,
        update: (newer(b) && newer(f)) ? 'both' : newer(b) ? 'backend' : newer(f) ? 'frontend' : null,
        state: (newer(b) || newer(f)) ? 'update' : (entry.code === 0 || (b.latest && f.latest)) ? 'current' : 'failed',
        limited: /HTTP error 403|rate limit/i.test(out + '\n' + (entry.stderr || ''))
    };
}

// The cached check_version result while it is fresh, else null. Only for this frontend version:
// a frontend update changes it. A success expires a minute early, so the hourly poll asks again
function cachedVersionCheck() {
    var entry = null, ttl;

    try { entry = JSON.parse(window.localStorage.getItem(VERSION_CACHE_KEY) || 'null'); } catch (e) {}
    if (!entry || typeof entry.stdout != 'string' || typeof entry.at != 'number' || entry.ui !== UI_VERSION)
        return null;
    ttl = (versionState(entry).state == 'failed') ? VERSION_RETRY : VERSION_INTERVAL - 60;
    return (Date.now() >= entry.at && Date.now() - entry.at < ttl * 1000) ? entry : null;
}

function storeVersionCheck(entry) {
    try { window.localStorage.setItem(VERSION_CACHE_KEY, JSON.stringify(entry)); } catch (e) {}
}

return view.extend({
    // Every map change is applied at once (commitGeomate), so the page has no footer
    handleSave: null,
    handleSaveApply: null,
    handleReset: null,

    knownChanges: '[]', // staged geomate changes at the last check, as JSON (stagedKey)
    notice: null,       // notification about staged geomate changes (showNotice)
    undo: null,         // { id, sid, before, after, extra } of the last applied change: Undo in the map toast
    undoSeq: 0,         // id of the last applied change
    generation: 0,      // counts the full map updates (pushFilters); older queued circle actions are dropped
    sidNames: {},       // filter name per section id as the map knows it (pushFilters, ackRegion)
    busy: null,         // promise chain that serializes map actions
    reported: {},       // region problems already shown, so a new map iframe does not repeat them
    connections: [],    // last getGeomateConnections result
    connectionsAt: null,    // time of the last getGeomateConnections reply
    connectionsFailed: 0,   // failed getGeomateConnections requests since that reply
    status: null,       // last getStatus result, null when it failed
    statusLoaded: false,    // a getStatus reply (or failure) has arrived
    health: null,       // last getHealthCheck result, null when it failed
    problems: [],       // problems of the last status poll: 'process' and check keys (updateStatus)
    confirmed: [],      // problems seen on two polls in a row; a new one opens the details
    versionInfo: null,  // last versionState() result, null before the first check
    readonly: true,     // no write access, or no configuration: the map only shows
    mapReady: false,
    focusSid: null,     // filter whose circles the first map view shows (#focus=<section>)
    nodes: null,        // nodes that the polls update in place
    pollFns: null,      // bound poll functions; poll.add() and poll.remove() match them by identity
    drawing: false,     // the map is drawing a circle (drawState)
    connectionsBusy: null,  // running getGeomateConnections request
    statusBusy: null,       // running status request
    versionBusy: null,      // running check_version request
    connectionsTable: null, // ui.Table of the active connections
    themeKey: null,         // last theme sent to the map, as JSON
    fullscreen: false,      // the map covers the window

    // Only what the map needs: LuCI sends the calls of one frame as one batch that the router
    // runs call by call, so getStatus (about 0.3 s) would delay the map. startPolls() fetches
    // the status. Each call may fail on its own; the page then renders with what it got
    load: function() {
        this.reported = {};
        return Promise.all([
            L.resolveDefault(uci.load('geomate'), null),
            L.resolveDefault(callUciChanges(), {})
        ]);
    },

    // Plain nodes, no form.Map: the polls never render the map iframe again
    render: function(data) {
        var configLoaded = data[0] != null;

        this.knownChanges = stagedKey(data[1]);
        // hasViewPermission() is what LuCI's footer uses without a form.Map
        this.readonly = !L.hasViewPermission() || !configLoaded;
        this.nodes = {};
        this.focusSid = this.takeFocusHash();

        if (!configLoaded)
            ui.addNotification(null, E('p', {}, [
                _('Could not load the geomate configuration. Reload the page.')
            ]), 'error');

        // Staged geomate changes, e.g. from the Geo Filters page: map changes wait for them
        if (!this.readonly && this.knownChanges !== '[]')
            this.showNotice();

        var nodes = E([], [ this.renderStatus(), this.renderMap(), this.renderConnections() ]);

        window.addEventListener('message', L.bind(this.handleMessage, this), false);
        // Escape outside the map also ends drawing, then fullscreen; the map handles it when it
        // has the focus. Capture phase: Escape that closes a LuCI dialog leaves fullscreen alone
        document.addEventListener('keydown', L.bind(function(ev) {
            if (ev.key !== 'Escape')
                return;
            if (this.drawing)
                this.sendMessageToMap('cancelDraw');
            else if (this.fullscreen && !document.body.classList.contains('modal-overlay-active'))
                this.setFullscreen(false);
        }, this), true);
        this.updateStatus();
        this.startPolls();
        this.watchTheme();

        return nodes;
    },

    // '#focus=<section>' (link "Show on map" of the Geo Filters page) names the filter whose
    // circles the first map view shows. The hash is cleared, so a reload starts at the usual view.
    // Returns the section id, or null for no hash or a section that is no geo_filter
    takeFocusHash: function() {
        var match = /^#focus=([^&]+)$/.exec(window.location.hash), sid = null;

        if (!match)
            return null;

        try { sid = decodeURIComponent(match[1]); } catch (e) { sid = null; }
        window.history.replaceState(null, '', window.location.pathname + window.location.search);

        return isGeoFilter(sid) ? sid : null;
    },

    // Status row: a <details> whose summary shows service, mode, checks, notes, versions and the
    // update state in one line, and whose panel lists each value. updateStatus() and
    // showVersions() change these nodes in place, so the open state the user chose stays
    renderStatus: function() {
        var n = this.nodes;

        var style = E('style', {}, `
            /* Theme colors with fallbacks, for the status row and the connection pills */
            #geomate-status, #active-connections-container {
                --gm-success: var(--success, var(--success-color-high, var(--success-color, #1a7f37)));
                --gm-danger: var(--danger, var(--error-color-high, var(--danger-color, var(--error-color, #cf222e))));
                --gm-primary: var(--primary, var(--primary-color-high, var(--main-bright-color, #1a6fd1)));
                --gm-warning: var(--warning, var(--warn-color-high, var(--warning-color, #9a6700)));
            }
            /* Pill: border and dot in --gm-status-color, the text in the theme's color */
            .gm-status {
                display: inline-flex;
                align-items: center;
                gap: 0.4em;
                padding: 0 0.6em;
                line-height: 1.6;
                white-space: nowrap;
                border: 1px solid var(--gm-status-color);
                border-radius: 999px;
            }
            .gm-status::before { content: ""; flex: none; width: 0.6em; height: 0.6em; border-radius: 50%; background: var(--gm-status-color); }
            .gm-status--running { --gm-status-color: var(--gm-success); }
            .gm-status--stopped { --gm-status-color: var(--gm-danger); }
            .gm-status--mode { --gm-status-color: var(--gm-primary); }
            .gm-status--neutral { --gm-status-color: currentColor; }
            #geomate-status [hidden] { display: none; }
            #geomate-status > summary { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; list-style: none; cursor: pointer; }
            #geomate-status > summary::-webkit-details-marker { display: none; }
            /* A mouse click leaves no focus ring (see noFocus); the keyboard ring uses the theme color */
            #geomate-status > summary:focus-visible { outline: 2px solid var(--gm-primary); outline-offset: -2px; }
            #geomate-status > summary:focus:not(:focus-visible) { outline: none; }
            #geomate-status .gm-spacer { flex: 1 1 0; }
            #geomate-status .gm-muted, #geomate-status .gm-icon--info { opacity: 0.65; }
            #geomate-status .gm-primary { color: var(--gm-primary); }
            /* Arrow of a summary toggle: here and in the connections header */
            .gm-arrow { display: inline-block; transition: transform 0.15s; }
            details[open] > summary .gm-arrow { transform: rotate(180deg); }
            /* The warning colors of Bootstrap and Material are too light for text on white: warning
               icons and dots carry the color, the text keeps the theme's color. Errors are text */
            #geomate-status .gm-icon--ok { color: var(--gm-success); }
            #geomate-status .gm-icon--warning { color: var(--gm-warning); }
            #geomate-status .gm-icon--error { color: var(--gm-danger); }
            #geomate-status .gm-note { font-size: 90%; }
            #geomate-status .gm-note::before { content: ""; display: inline-block; width: 0.5em; height: 0.5em; margin-right: 0.4em; border-radius: 50%; background: var(--gm-warning); }
            #geomate-status .gm-status-details { position: relative; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 16px; align-items: center; margin-top: 8px; padding: 8px 12px; font-size: 90%; overflow-wrap: anywhere; }
            /* A faint border in the theme's text color */
            #geomate-status .gm-status-details::before { content: ""; position: absolute; top: 0; right: 0; bottom: 0; left: 0; border: 1px solid currentColor; border-radius: 4px; opacity: 0.2; pointer-events: none; }
            #geomate-status .gm-contents { display: contents; }
            #geomate-status .gm-status-details .cbi-button { margin: 0 0 0 8px; }
            @media (max-width: 639px) {
                #geomate-status .gm-wide { display: none; }
            }
        `);

        // A key and its value in the details panel
        var row = function(label, value) {
            return [ E('span', { 'class': 'gm-muted' }, [ label ]), value ];
        };

        n.state = E('span', { 'id': 'service-status-text', 'class': 'gm-status gm-status--neutral gm-muted' });
        n.mode = E('span', { 'id': 'operational-mode-text', 'class': 'gm-status gm-status--mode' });
        n.health = E('span', { 'id': 'health-check-status' });
        n.loading = E('span', { 'id': 'geomate-loading-indicator', 'class': 'gm-note' }, [ _('Loading GeoFilter data ...') ]);
        n.stale = E('span', { 'id': 'geomate-connections-stale', 'class': 'gm-note' });
        n.version = E('span', { 'id': 'version-display', 'class': 'gm-muted gm-wide' });
        n.update = E('span', { 'id': 'version-update-status', 'class': 'gm-wide' });

        n.detailService = E('span');
        n.detailMode = E('span');
        n.detailChecks = E('div', { 'class': 'gm-contents' });
        n.checkRows = {};   // { icon, text, cells } per check key (updateStatus)
        n.checkKeys = null; // keys of the rows in detailChecks
        n.detailBackend = E('span');
        n.detailFrontend = E('span');
        n.detailUpdate = E('span');
        n.recheck = E('button', {
            'class': 'btn cbi-button cbi-button-neutral',
            'click': L.bind(function() { this.checkForUpdates(true); }, this)
        }, [ _('Check again') ]);

        n.statusRow = E('details', { 'id': 'geomate-status' }, [
            E('summary', { 'mousedown': noFocus }, [
                n.state, n.mode, n.health, n.loading, n.stale,
                E('span', { 'class': 'gm-spacer' }),
                n.version, n.update,
                E('span', { 'class': 'gm-muted' }, [ _('Details'), ' ', E('span', { 'class': 'gm-arrow' }, [ '▾' ]) ])
            ]),
            E('div', { 'class': 'gm-status-details' }, [].concat(
                row(_('Service'), n.detailService),
                row(_('Mode'), n.detailMode),
                [ n.detailChecks ],
                row(_('Backend'), n.detailBackend),
                row(_('Frontend'), n.detailFrontend),
                row(_('Updates'), E('span', {}, [ n.detailUpdate, n.recheck ]))
            ))
        ]);

        return E('div', {}, [ style, n.statusRow ]);
    },

    // Choices of the filter select in the new region dialog: placeholder (''), every named
    // filter in config order, then 'New filter…'. Returns { sections, choices, sort } for ui.Select
    filterChoices: function(placeholder) {
        var sections = uci.sections('geomate', 'geo_filter').filter(function(s) { return s.name; }),
            choices = { '': placeholder };

        sections.forEach(function(s) {
            choices[s['.name']] = (s.enabled === '1') ? s.name : _('%s (disabled)').format(s.name);
        });
        choices[NEW_FILTER] = _('New filter…');

        return {
            sections: sections,
            choices: choices,
            sort: [ '' ].concat(sections.map(function(s) { return s['.name']; }), [ NEW_FILTER ])
        };
    },

    renderMap: function() {
        var n = this.nodes;

        var style = E('style', {}, `
            /* No side margin: the map and the sections around it share the edges of the page content */
            #geomate-map-container { margin: 12px 0 0; }
            .gm-map-frame { display: block; width: 100%; height: 80vh; border: 0; }
            .gm-map-frame.gm-map-frame--short { height: 600px; height: min(600px, 80vh); }
            @media (max-width: 767px) {
                .gm-map-frame, .gm-map-frame.gm-map-frame--short { height: 60vh; }
            }
            /* Fullscreen: the map covers the window. An ancestor with its own z-index (Argon's
               #maincontent) is lifted with it; a LuCI dialog stays above both */
            #geomate-map-container.gm-map-fullscreen { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 10000; margin: 0; }
            #geomate-map-container.gm-map-fullscreen .gm-map-frame { height: 100%; }
            body.gm-map-fullscreen-active { overflow: hidden; }
            .gm-map-fullscreen-lift { z-index: 10000 !important; }
            body.modal-overlay-active #geomate-map-container.gm-map-fullscreen,
            body.modal-overlay-active .gm-map-fullscreen-lift { z-index: 899 !important; }
        `);

        n.frame = E('iframe', {
            // The version parameter makes browsers fetch map.html again after an update
            src: L.resource('view/geomate/map.html') + '?v=' + encodeURIComponent(UI_VERSION),
            title: _('Geomate map'),
            'class': 'gm-map-frame'
        });
        // Probes for detectTheme(): theme colors resolved by the browser, never shown
        n.colorProbe = E('span', { 'style': 'display: none' });
        n.surfaceProbe = E('div', { 'class': 'cbi-section', 'style': 'display: none' });
        n.mapBox = E('div', { id: 'geomate-map-container' }, [ style, n.frame, n.colorProbe, n.surfaceProbe ]);

        return n.mapBox;
    },

    /**
     * Colors of the LuCI theme for the map: dark or light from the luminance of the page
     * background, the control surface from the theme's section background, accent, danger and
     * success from the theme's CSS variables (THEME_VARS) with fallbacks.
     */
    detectTheme: function() {
        var n = this.nodes,
            vars = window.getComputedStyle(document.body),
            dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches,
            page = null, surface, fg, fallback, el, c;

        // The first ancestor of the map that paints a background
        for (el = n.mapBox; el && !page; el = el.parentElement) {
            c = parseRgb(window.getComputedStyle(el).backgroundColor);
            if (c && c.a > 0.5)
                page = c;
        }
        if (page)
            dark = luminance(page) < 0.2;
        fallback = THEME_FALLBACKS[dark ? 'dark' : 'light'];

        // Sections are white on Argon's grey page; Argon dark paints none, so the page color stays
        c = parseRgb(window.getComputedStyle(n.surfaceProbe).backgroundColor);
        surface = (c && c.a > 0.5 && (luminance(c) < 0.2) === dark) ? c : (page || parseRgb(fallback.bg));

        // Text must contrast with the surface, else the fallback
        c = parseRgb(window.getComputedStyle(n.mapBox).color);
        fg = (c && (luminance(c) > 0.4) === dark) ? c : parseRgb(fallback.fg);

        var resolve = function(names, color) {
            for (var i = 0; i < names.length; i++) {
                if (vars.getPropertyValue(names[i]).trim() === '')
                    continue;
                n.colorProbe.style.color = 'var(' + names[i] + ')';
                c = parseRgb(window.getComputedStyle(n.colorProbe).color);
                if (c && c.a > 0.5)
                    return rgbString(c);
            }
            return color;
        };

        var theme = {
            dark: dark,
            bg: rgbString(surface),
            fg: rgbString(fg),
            border: rgbString(fg, 0.35),
            accent: resolve(THEME_VARS.accent, fallback.accent),
            danger: resolve(THEME_VARS.danger, fallback.danger),
            success: resolve(THEME_VARS.success, fallback.success)
        };
        theme.accentFg = textOn(theme.accent);
        theme.dangerFg = textOn(theme.danger);
        return theme;
    },

    // Send the theme to the map when it differs from the last one sent (always with force)
    sendTheme: function(force) {
        var theme, key;

        if (!this.mapReady)
            return;
        theme = this.detectTheme();
        key = JSON.stringify(theme);
        if (force || key !== this.themeKey) {
            this.themeKey = key;
            this.sendMessageToMap('theme', theme);
        }
    },

    // Follow theme changes without a reload: the OS color scheme (Argon in its default mode)
    // and attributes such as data-darkmode on <html> (Bootstrap). Transitions of the theme
    // (Argon fades backgrounds) end before the second look
    watchTheme: function() {
        var self = this, timer = null;
        var update = function() {
            self.sendTheme(false);
            window.clearTimeout(timer);
            timer = window.setTimeout(function() { self.sendTheme(false); }, 400);
        };
        var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');

        if (mq && mq.addEventListener)
            mq.addEventListener('change', update);
        else if (mq && mq.addListener)
            mq.addListener(update);

        if (window.MutationObserver) {
            var mo = new MutationObserver(update);
            mo.observe(document.documentElement, { attributes: true, attributeFilter: [ 'class', 'style', 'data-darkmode', 'data-theme' ] });
            mo.observe(document.body, { attributes: true, attributeFilter: [ 'class', 'style' ] });
        }
    },

    /**
     * Shows the map in the whole window or back in the page; the map asks for it with its
     * fullscreen button and Escape, the view answers with the new state.
     * @param {boolean} on - Fullscreen on.
     */
    setFullscreen: function(on) {
        var box = this.nodes && this.nodes.mapBox, el;

        on = !!on;
        if (!box || on === this.fullscreen)
            return this.sendMessageToMap('fullscreen', { on: this.fullscreen });

        this.fullscreen = on;
        box.classList.toggle('gm-map-fullscreen', on);
        document.body.classList.toggle('gm-map-fullscreen-active', on);
        // position: fixed stays inside the stacking context of an ancestor with a z-index
        if (on) {
            for (el = box.parentElement; el && el !== document.body; el = el.parentElement)
                if (window.getComputedStyle(el).zIndex !== 'auto')
                    el.classList.add('gm-map-fullscreen-lift');
        }
        else {
            document.querySelectorAll('.gm-map-fullscreen-lift').forEach(function(lifted) {
                lifted.classList.remove('gm-map-fullscreen-lift');
            });
        }
        this.sendMessageToMap('fullscreen', { on: on });
    },

    // Section below the map: a <details> whose summary is the "Active connections (n)" heading
    // with a Show/Hide label, and the table, collapsed until shown
    renderConnections: function() {
        var n = this.nodes;

        var style = E('style', {}, `
            /* No side margin, whatever the theme gives a section: the same edges as the map */
            #active-connections-container { margin: 12px 0 0; }
            #active-connections-container > summary { display: block; list-style: none; cursor: pointer; }
            #active-connections-container > summary::-webkit-details-marker { display: none; }
            #active-connections-container > summary:focus-visible { outline: 2px solid var(--gm-primary); outline-offset: -2px; }
            #active-connections-container > summary:focus:not(:focus-visible) { outline: none; }
            /* The heading keeps the theme's look; a theme may give h3 width: 100% */
            #active-connections-container h3 { display: flex; align-items: center; gap: 8px; min-width: 0; width: auto; margin: 0; }
            #active-connections-container .gm-connections-title { flex: 1 1 auto; min-width: 0; }
            /* Themes that uppercase headings leave the label as it is */
            #active-connections-container .gm-connections-toggle { flex: none; font-size: 13px; font-weight: normal; opacity: 0.7; white-space: nowrap; text-transform: none; letter-spacing: normal; }
            #active-connections-container .gm-connections-wrap { max-height: 400px; overflow: auto; margin-top: 8px; }
            #active-connections-container .table { margin: 0; }
            /* Pills and theme colors: renderStatus */
            .gm-status--allowed { --gm-status-color: var(--gm-success); }
            .gm-status--blocked { --gm-status-color: var(--gm-danger); }
            .gm-status--whitelist { --gm-status-color: var(--gm-primary); }
            .gm-status--untracked, .gm-status--unknown { --gm-status-color: #8c959f; }
        `);

        // Sortable columns; the theme styles the table like every LuCI table
        this.connectionsTable = new ui.Table(
            [ _('IP'), _('Filter'), _('Status'), _('Country'), _('City'), _('ISP') ],
            { id: 'geomate-connections', sortable: true, placeholder: _('No active connections') },
            E('em', {}, [ _('Loading connections…') ])
        );

        // updateActiveConnectionsList() sets the count in the title span
        n.connectionsTitle = E('span', { 'class': 'gm-connections-title' }, [ _('Active connections') ]);
        n.connectionsToggle = E('span', {}, [ _('Show') ]);

        n.connections = E('details', {
            'class': 'cbi-section',
            'id': 'active-connections-container',
            'toggle': L.bind(this.toggleConnections, this)
        }, [
            style,
            E('summary', { 'mousedown': noFocus }, [
                E('h3', {}, [
                    n.connectionsTitle,
                    E('span', { 'class': 'gm-connections-toggle' }, [ n.connectionsToggle, ' ', E('span', { 'class': 'gm-arrow' }, [ '▾' ]) ])
                ])
            ]),
            E('div', { 'class': 'gm-connections-wrap', 'id': 'gm-connections-wrap' }, [ this.connectionsTable.render() ])
        ]);

        return n.connections;
    },

    // After the connections section opened or closed: the map gets smaller while the table is shown
    toggleConnections: function() {
        var n = this.nodes,
            show = n.connections.open;

        n.connectionsToggle.textContent = show ? _('Hide') : _('Show');
        n.frame.classList.toggle('gm-map-frame--short', show);
        if (show)
            n.connections.scrollIntoView({ behavior: 'smooth' });
    },

    // Show the last status and health check in the status row; polled: with a new status reply.
    // A problem (service stopped although enabled, a check with an error or warning) seen on two
    // polls in a row opens the details once, so a restart or one failed reply does not; they
    // never close on their own
    updateStatus: function(polled) {
        var n = this.nodes,
            st = this.status,
            checks = this.health && this.health.checks,
            running = !!(st && st.running),
            pid = running && st.pid,
            loading = !!(st ? st.loading : (this.health && this.health.loading)),
            problems = (st && !running && st.config_enabled !== false) ? [ 'process' ] : [];

        if (!n)
            return;

        var state = st ? (running ? _('Running') : _('Not running'))
            : (this.statusLoaded ? _('Status unknown') : _('Loading status...'));
        n.state.textContent = state;
        n.state.className = 'gm-status ' + (st ? (running ? 'gm-status--running' : 'gm-status--stopped') : 'gm-status--neutral gm-muted');
        n.state.title = pid ? _('PID %d').format(pid) : '';
        n.detailService.textContent = pid ? _('Running (PID %d)').format(pid) : state;
        n.loading.hidden = !loading;

        // Operational mode of the committed configuration, the one the service runs with
        var modes = {
            monitor: [ _('Monitor mode'), _('Connections are tracked but not blocked.') ],
            static: [ _('Static mode'), _('Uses the IP lists as they are.') ],
            dynamic: [ _('Dynamic mode'), _('Builds IP lists automatically.') ]
        };
        var mode = (st && st.operational_mode) ? (modes[st.operational_mode] || modes.dynamic) : null;
        n.mode.hidden = !mode;
        n.mode.textContent = mode ? mode[0] : '';
        n.mode.title = mode ? mode[1] : '';
        n.detailMode.textContent = mode ? mode[1] : '–';

        // Health checks; process and loading are shown by the service pill and the loading note.
        // 'info' (e.g. autostart disabled) is no problem. Messages stay text, never markup
        var shown = !checks ? [] : [
            [ 'config', _('Config') ],
            [ 'files', _('Files') ],
            [ 'datadir', _('Data') ],
            [ 'service', _('Autostart') ],
            [ 'nft', _('nftables') ],
            [ 'nft_errors', _('nft errors') ]
        ].filter(function(c) { return checks[c[0]]; }).map(function(c) {
            var status = CHECK_ICONS[checks[c[0]].status] ? checks[c[0]].status : 'ok';
            return { key: c[0], label: c[1], status: status, message: ' ' + String(checks[c[0]].message || '') };
        });
        var failing = function(status) {
            return shown.filter(function(c) { return c.status == status; });
        };
        var errors = failing('error'), warnings = failing('warning'),
            labels = (errors.length ? errors : warnings).map(function(c) { return c.label; }).join(', ');

        n.health.title = shown.map(function(c) { return c.label + ':' + c.message; }).join('\n');
        dom.content(n.health, !shown.length ? null
            : errors.length ? E('span', { 'class': 'gm-icon--error' }, [ CHECK_ICONS.error + ' ' + labels ])
            : warnings.length ? [ E('span', { 'class': 'gm-icon--warning' }, [ CHECK_ICONS.warning ]), ' ' + labels ]
            : E('span', { 'class': 'gm-muted' }, [ CHECK_ICONS.ok + ' ' + _('All checks passed') ]));

        // The check rows change in place, so a selected message stays selected
        shown.forEach(function(c) {
            var r = n.checkRows[c.key];

            if (!r) {
                r = n.checkRows[c.key] = { icon: E('span'), text: document.createTextNode('') };
                r.cells = [ E('span', { 'class': 'gm-muted' }, [ c.label ]), E('span', {}, [ r.icon, r.text ]) ];
            }
            r.icon.className = 'gm-icon--' + c.status;
            if (r.icon.textContent !== CHECK_ICONS[c.status])
                r.icon.textContent = CHECK_ICONS[c.status];
            if (r.text.data !== c.message)
                r.text.data = c.message;
        });
        var keys = shown.map(function(c) { return c.key; }).join(' ');
        if (keys !== n.checkKeys) {
            n.checkKeys = keys;
            dom.content(n.detailChecks, shown.reduce(function(cells, c) { return cells.concat(n.checkRows[c.key].cells); }, []));
        }
        problems = problems.concat(errors.concat(warnings).map(function(c) { return c.key; }));

        // A single failed request keeps the last list silently; a lasting failure becomes visible
        var stale = this.connectionsFailed >= CONNECTIONS_STALE_AFTER;
        n.stale.hidden = !stale;
        n.stale.textContent = !stale ? '' : this.connectionsAt
            ? _('Connections not updated since %s').format(new Date(this.connectionsAt).toLocaleTimeString())
            : _('Connections unavailable');

        // A failed reply tells nothing, and the service builds its table while it loads
        if (!polled || !st || !checks || loading)
            return;
        var last = this.problems,
            confirmed = problems.filter(function(p) { return last.indexOf(p) >= 0; });
        if (confirmed.some(function(p) { return this.confirmed.indexOf(p) < 0; }, this))
            n.statusRow.open = true;
        this.problems = problems;
        this.confirmed = confirmed;
    },

    // Show the versions and the update state of versionInfo; before the first result the
    // frontend version of this file
    showVersions: function() {
        var n = this.nodes,
            v = this.versionInfo || versionState({}),
            versions = [],
            summary = '', detail = '', primary = false;

        if (!n)
            return;

        if (v.backend.current)
            versions.push(_('Backend %s').format(formatVersionDisplay(v.backend.current)));
        if (v.frontend.current)
            versions.push(_('Frontend %s').format(formatVersionDisplay(v.frontend.current)));
        n.version.textContent = versions.join(' · ');

        [ [ n.detailBackend, v.backend ], [ n.detailFrontend, v.frontend ] ].forEach(function(d) {
            d[0].textContent = !d[1].current ? '–' : d[1].channel ? '%s (%s)'.format(d[1].current, d[1].channel) : d[1].current;
        });

        if (this.versionBusy) {
            summary = detail = _('Checking...');
        }
        else if (!this.versionInfo) {
            // No check yet
        }
        else if (v.error) {
            summary = _('Update check failed');
            detail = _('Could not run the update check: %s').format(v.error);
        }
        else if (v.state == 'update') {
            summary = (v.update == 'both') ? _('Update available')
                : (v.update == 'backend') ? _('Backend update available') : _('Frontend update available');
            detail = (v.update == 'both') ? _('Backend and frontend updates available') : summary;
            primary = true;
        }
        else if (v.state == 'current') {
            summary = detail = _('Up to date');
        }
        else {
            summary = _('Update check failed');
            detail = v.limited ? _('GitHub limit reached. Try again later.') : _('GitHub did not answer. Try again later.');
        }

        n.update.textContent = summary;
        n.update.className = 'gm-wide ' + (primary ? 'gm-primary' : 'gm-muted');
        n.detailUpdate.textContent = detail;
        n.recheck.disabled = !!this.versionBusy;
    },

    // Polls are added once, after the first render, as bound functions: poll.add() skips only a
    // function it already has. poll runs a function when its global tick is a multiple of the
    // interval, so the first requests of all three are sent here (the busy guards let a poll that
    // starts at tick 0 share them)
    startPolls: function() {
        if (this.pollFns)
            return;

        this.pollFns = {
            connections: L.bind(this.pollConnections, this),
            status: L.bind(this.pollStatus, this),
            version: L.bind(this.checkForUpdates, this)
        };

        if (!document.hidden)
            poll.add(this.pollFns.connections, CONNECTIONS_INTERVAL);
        poll.add(this.pollFns.status, STATUS_INTERVAL);
        poll.add(this.pollFns.version, VERSION_INTERVAL);

        this.pollConnections();
        this.pollStatus();
        this.checkForUpdates();

        document.addEventListener('visibilitychange', L.bind(this.handleVisibilityChange, this));
    },

    // No connection requests while the tab is hidden
    handleVisibilityChange: function() {
        if (document.hidden) {
            poll.remove(this.pollFns.connections);
        } else {
            poll.add(this.pollFns.connections, CONNECTIONS_INTERVAL);
            // Fresh data at once, unless the user paused LuCI's auto refresh
            if (poll.active())
                this.pollConnections();
        }
    },

    // One request at a time, like pollConnections()
    pollStatus: function() {
        var self = this;

        if (!this.statusBusy)
            this.statusBusy = Promise.all([
                L.resolveDefault(callGetStatus(), null),
                L.resolveDefault(callGetHealthCheck(), null)
            ]).then(function(r) {
                self.status = r[0];
                self.health = r[1];
                self.statusLoaded = true;
                self.updateStatus(true);
            }).finally(function() {
                self.statusBusy = null;
            });

        return this.statusBusy;
    },

    // One request at a time: a direct call while the poll's request runs shares it
    pollConnections: function() {
        var self = this;

        if (!this.connectionsBusy)
            this.connectionsBusy = L.resolveDefault(callGeomateConnections(), null).then(function(list) {
                var failed = self.connectionsFailed;

                self.connectionsFailed = list ? 0 : failed + 1;
                if (list)
                    self.connectionsAt = Date.now();
                if (self.connectionsFailed >= CONNECTIONS_STALE_AFTER || failed >= CONNECTIONS_STALE_AFTER)
                    self.updateStatus();
                if (!list) {
                    // Without any reply the table would keep saying it loads
                    if (self.connectionsAt == null && self.connectionsFailed == CONNECTIONS_STALE_AFTER && self.connectionsTable)
                        self.connectionsTable.update([], _('Connections unavailable'));
                    return;
                }
                self.connections = list;
                self.sendMessageToMap('updateConnections', list);
                self.updateActiveConnectionsList();
            }).finally(function() {
                self.connectionsBusy = null;
            });

        return this.connectionsBusy;
    },

    // Only the map iframe of this page may send messages to the view
    isMapMessage: function(ev) {
        var frame = this.nodes && this.nodes.frame;
        return ev.origin === window.location.origin && frame != null &&
            ev.source === frame.contentWindow && ev.data != null && typeof ev.data.type == 'string';
    },

    // Send a message to the map iframe once it has loaded
    sendMessageToMap: function(type, data) {
        var frame = this.nodes && this.nodes.frame;
        if (this.mapReady && frame && frame.contentWindow)
            frame.contentWindow.postMessage({ type: type, data: data }, window.location.origin);
    },

    // The one message listener of the view. The messages in both directions are listed at the
    // message listener in map.html
    handleMessage: function(ev) {
        if (!this.isMapMessage(ev))
            return;

        var self = this, type = ev.data.type, d = ev.data.data || {};

        // Without write access nothing is applied; the map has no drawing tools then anyway
        if (this.readonly && type == 'toastAction')
            return;
        if (this.readonly && /^region(Drawn|Edited|Deleted)$/.test(type))
            return this.sendMessageToMap((type == 'regionDrawn') ? 'regionDiscarded' : 'regionRejected', { token: d.token, reason: '' });

        switch (type) {
        case 'mapReady':
            this.mapReady = true;
            this.drawing = false;
            this.sendTheme(true);
            this.sendMessageToMap('fullscreen', { on: this.fullscreen });
            this.sendMessageToMap('setReadonly', { readonly: this.readonly });
            // Once, before the first setFilters, which then fits the start view to this filter
            if (this.focusSid) {
                this.sendMessageToMap('fitFilter', { sid: this.focusSid });
                this.focusSid = null;
            }
            this.pushFilters();
            this.sendMessageToMap('updateConnections', this.connections);
            break;
        case 'drawState':
            this.drawing = !!d.drawing;
            break;
        case 'fullscreen':
            this.setFullscreen(d.on);
            break;
        case 'regionDrawn':
            this.enqueue(d.token, d.sid, function() { return self.addDrawnRegion(d.token, d.region, d.sid); });
            break;
        case 'toastAction':
            if (d.name == 'enableFilter')
                this.enableFilter(d.sid);
            else if (d.name == 'undo')
                this.undoChange(d.id);
            break;
        case 'regionEdited':
            this.enqueue(d.token, d.sid, function() { return self.replaceRegion(d.token, d.sid, d.oldRegion, d.region); });
            break;
        case 'regionDeleted':
            this.enqueue(d.token, d.sid, function() { return self.removeRegion(d.token, d.sid, d.oldRegion); });
            break;
        case 'regionInvalid':
            this.warnOnce(d.sid + ' ' + d.region, _('Filter %s has an invalid circle "%s". Fix it on the Geo Filters page.')
                .format(this.filterName(d.sid), d.region));
            break;
        }
    },

    // Run map actions one after another, each on the configuration as committed now (another
    // tab may have applied changes since): uci.save() reloads it, so a second action must not
    // read it in between. checkStaged() may stop an action before it changes anything; its
    // circle then goes back (token), or onRefuse(reason) answers. An action with a circle queued
    // before the map got all filters again (pushFilters) is dropped: the map no longer has its
    // circle. So is an action whose filter id sid names another filter now than at the click
    // (movedFilter; a resync queued before may have renamed the id in sidNames since). A failed
    // action shows the error, and the map shows the configuration again (resync)
    enqueue: function(token, sid, fn, onRefuse) {
        var self = this, generation = this.generation, known = this.sidNames[sid];

        this.busy = Promise.resolve(this.busy).then(function() {
            if (self.readonly)
                return token && self.sendMessageToMap('regionRejected', { token: token, reason: '' });
            if (token && generation !== self.generation)
                return self.sendMessageToMap('toast', { text: _('Not applied: the map was reloaded.') });
            return self.checkStaged().then(function(ok) {
                var reason = (ok === null) ? _('Could not check for unsaved changes.')
                    : _('Apply or revert the unsaved geomate changes first.');

                if (!ok) {
                    if (token)
                        return self.sendMessageToMap('regionRejected', { token: token, reason: reason });
                    return onRefuse ? onRefuse(reason) : self.sendMessageToMap('toast', { text: reason });
                }
                return self.loadConfig().then(function() {
                    if (self.movedFilter(sid, known))
                        throw filtersChanged();
                    return fn();
                });
            });
        }).catch(function(err) {
            return self.resync((err && err.plain) ? err.message
                : _('Could not apply the change: %s').format(errorText(err)), token);
        });
        return this.busy;
    },

    // Drop the in-memory configuration and load it as the session holds it now: at the start of
    // each map action, again after a dialog, which may have stayed open while another tab
    // applied changes, and in resync
    loadConfig: function() {
        uci.unload('geomate');
        return uci.load('geomate');
    },

    // The section id sid names another filter than known, the name the map had for it: geo_filter
    // sections are anonymous, so deleting one (e.g. in another tab) shifts the ids of all filters
    // after it. An id that is gone does not count: the actions handle a deleted filter themselves.
    // Filters are told apart by name only, so two filters of the same name pass as one
    movedFilter: function(sid, known) {
        return isGeoFilter(sid) && known !== (uci.get('geomate', sid, 'name') || '');
    },

    // The one call that makes map changes active: commit the geomate configuration of this
    // session. procd's reload trigger then reloads geomate (an older backend restarts it).
    // The page also works when this resolves without committing anything
    commitGeomate: function() {
        return callUciCommit('geomate');
    },

    // Save the in-memory changes in the session, check the reloaded configuration (verify
    // throws when it lacks the change), then commit. checkStaged() runs again first: a dialog
    // may have stayed open while geomate changes were staged elsewhere
    applyChange: function(verify) {
        var self = this;

        return this.checkStaged().then(function(ok) {
            if (ok === null)
                throw failure(_('Could not check for unsaved changes.'));
            if (!ok)
                throw failure(_('Apply or revert the unsaved geomate changes first.'));
            return uci.save();
        }).then(function() {
            if (verify)
                verify();
            return self.commitGeomate();
        }).then(function() {
            return self.refreshChanges();
        });
    },

    // Resolves false while the session holds staged geomate changes, e.g. from the Geo Filters
    // page: a commit would apply them too, unseen. The notice offers LuCI's changes dialog.
    // null: the check failed, which must not count as "nothing staged"
    checkStaged: function() {
        var self = this;

        return L.resolveDefault(callUciChanges(), null).then(function(changes) {
            if (!changes)
                return null;
            self.knownChanges = stagedKey(changes);
            if (self.knownChanges !== '[]') {
                self.showNotice();
                return false;
            }
            self.hideNotice();
            return true;
        });
    },

    // Fetch the staged changes after a commit: LuCI's header indicator counted them at the last
    // uci.save(). The notice shows while geomate has any left
    refreshChanges: function() {
        var self = this;

        return L.resolveDefault(callUciChanges(), null).then(function(changes) {
            if (!changes)
                return;
            self.knownChanges = stagedKey(changes);
            ui.changes.renderChangeIndicator(changes);
            if (self.knownChanges === '[]')
                self.hideNotice();
            else
                self.showNotice();
        });
    },

    // One notification about staged geomate changes, with a button to LuCI's changes dialog
    showNotice: function() {
        var n = this.notice;

        if (n && n.parentNode && !n.classList.contains('fade-out'))
            return;
        this.notice = ui.addNotification(null, [
            E('p', {}, [ _('Apply or revert the unsaved geomate changes before you change the map.') ]),
            E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(this, 'showChanges') }, [ _('Show changes') ])
        ], 'info');
    },

    hideNotice: function() {
        var n = this.notice;

        if (n && n.parentNode)
            n.parentNode.removeChild(n);
        this.notice = null;
    },

    // LuCI's dialog of the staged changes (Unsaved Changes in the header), with fresh content
    showChanges: function() {
        return L.resolveDefault(callUciChanges(), null).then(function(changes) {
            if (changes)
                ui.changes.renderChangeIndicator(changes);
            ui.changes.displayChanges();
        });
    },

    // After a failed change: drop the in-memory changes, load the configuration as the session
    // holds it and show it on the map, with the error. A change that was saved but not
    // committed stays staged, and the notice shows. Without a configuration the map keeps its
    // circles and loses its tools, so nothing is applied on top of a missing one
    resync: function(reason, token) {
        var self = this;

        return L.resolveDefault(this.loadConfig(), null).then(function(loaded) {
            if (!loaded) {
                self.readonly = true;
                self.sendMessageToMap('setReadonly', { readonly: true });
                if (token)
                    self.sendMessageToMap('regionRejected', { token: token, reason: '' });
                return self.sendMessageToMap('toast', { text: reason + ' ' + _('Reload the page.') });
            }
            return self.refreshChanges().then(function() {
                self.pushFilters();
                self.sendMessageToMap('toast', { text: reason });
            });
        });
    },

    /**
     * 'Applied.' in the map with Undo, which restores the options the change set. Only the last
     * change can be undone. Call it after applyChange(): after is the reloaded filter.
     * @param {string} sid - The filter section.
     * @param {Object|null} before - Its options before the change (filterOptions); null: the
     *   change created the filter, Undo deletes it.
     * @param {string} [text] - Another text.
     * @param {Array} [extra] - Toast buttons before Undo: [{ name, sid, label }].
     */
    showApplied: function(sid, before, text, extra) {
        this.undo = { id: ++this.undoSeq, sid: sid, before: before, after: filterOptions(sid), extra: extra || [] };
        this.sendToast(text || _('Applied.'), this.undo);
    },

    // A map toast with the buttons of the applied change u (its extra buttons and Undo) while it
    // is the last change. action: a button the toast gets in any case. A refused toast button
    // (checkStaged) shows its toast again this way, so Enable and Undo both stay available
    sendToast: function(text, u, action) {
        var actions = (u && u === this.undo) ? u.extra.concat([ { name: 'undo', id: u.id, label: _('Undo') } ]) : [];

        if (action && !actions.some(function(a) { return a.name === action.name && a.sid === action.sid; }))
            actions.unshift(action);
        this.sendMessageToMap('toast', { text: text, actions: actions });
    },

    // Undo in the map toast: write back the options the change set, apply that, show all
    // filters again. Not when they have changed since, e.g. in another tab. A refusal by
    // checkStaged() offers the toast's buttons again
    undoChange: function(id) {
        var self = this, u = this.undo;

        if (!u || u.id !== id)
            return;

        return this.enqueue(null, u.sid, function() {
            var now = filterOptions(u.sid),
                name = (u.before && u.before.name) || (u.after && u.after.name) || u.sid,
                keys = u.before ? changedOptions(u.after || {}, u.before) : null;

            // A change queued before the click has been applied since: Undo would revert it too
            if (self.undoSeq !== u.id)
                return self.sendMessageToMap('toast', { text: _('Only the last change can be undone.') });
            // Clicked twice: undone already
            if (self.undo !== u)
                return;
            self.undo = null;
            if (!now || !u.after)
                throw failure(_('Filter %s not found.').format(name));
            if (keys ? changedOptions(pick(now, keys), pick(u.after, keys)).length : changedOptions(now, u.after).length)
                return self.sendMessageToMap('toast', { text: _('Not undone: filter %s has changed since.').format(name) });

            if (!u.before)
                uci.remove('geomate', u.sid);
            else
                keys.forEach(function(k) {
                    uci.set('geomate', u.sid, k, (u.before[k] != null) ? u.before[k] : null);
                });

            return self.applyChange(function() {
                var after = filterOptions(u.sid);
                if (u.before ? (!after || changedOptions(pick(after, keys), pick(u.before, keys)).length) : after)
                    throw failure(_('Could not undo the change of filter %s.').format(name));
            }).then(function() {
                self.pushFilters();
                self.sendMessageToMap('toast', { text: _('Undone.') });
            });
        }, function(reason) {
            self.sendToast(reason, u);
        });
    },

    filterName: function(sid) {
        return (sid && uci.get('geomate', sid, 'name')) || sid || '?';
    },

    // Filter fields the map needs; colors follow the section order
    filterInfo: function(sid) {
        var sections = uci.sections('geomate', 'geo_filter'),
            index = sections.findIndex(function(s) { return s['.name'] === sid; }),
            name = (index > -1 && sections[index].name) || '';

        return {
            sid: sid,
            name: name,
            color: filterColor(Math.max(index, 0)),
            enabled: index > -1 && sections[index].enabled === '1'
        };
    },

    // Show a warning about a filter's regions once per page load. It stays until dismissed:
    // the user may act on it only later, when drawing a region for that filter
    warnOnce: function(key, text) {
        if (this.reported[key])
            return;
        this.reported[key] = true;
        ui.addNotification(null, E('p', {}, [ text ]), 'warning');
    },

    // Copy of a filter's region list. A hand-written 'option allowed_region' (a string) counts as
    // no region: the service start and luci.geomate read only 'list allowed_region'
    regionList: function(sid) {
        var v = sid ? uci.get('geomate', sid, 'allowed_region') : null;
        return Array.isArray(v) ? v.slice() : [];
    },

    // Send every filter to the map, also disabled ones: at mapReady, after Undo and after a
    // failed change. The map drops its circles, so circle actions queued before are dropped too
    pushFilters: function() {
        var self = this;

        this.generation++;
        this.sidNames = {};
        this.sendMessageToMap('setFilters', {
            filters: uci.sections('geomate', 'geo_filter').map(function(s) {
                self.sidNames[s['.name']] = s.name || '';
                if (typeof s.allowed_region == 'string')
                    self.warnOnce(s['.name'] + ' option', _('Filter %s has "option allowed_region %s", which the map cannot show and the service start skips. A circle drawn for this filter replaces it.')
                        .format(s.name || s['.name'], s.allowed_region));
                return Object.assign(self.filterInfo(s['.name']), { regions: self.regionList(s['.name']) });
            })
        });
    },

    // A circle was drawn for a filter chosen in the map's draw menu (sid), or for a new filter
    // (sid null). An existing filter gets the region without a dialog
    addDrawnRegion: function(token, region, sid) {
        if (!isGeoFilter(sid))
            // A filter that disappeared since the map got the filter list: the dialog's list decides
            return this.openFilterModal(token, region, sid ? '' : NEW_FILTER);
        if (!validRegion(region))
            return Promise.reject(new Error(_('Invalid circle %s').format(region)));

        var self = this,
            name = this.filterName(sid),
            list = this.regionList(sid),
            before = filterOptions(sid),
            disabled = uci.get('geomate', sid, 'enabled') !== '1';

        if (list.indexOf(region) < 0)
            list.push(region);
        uci.set('geomate', sid, 'allowed_region', list);

        // Drawing never enables a filter; a disabled one gets a one-click offer next to Undo.
        // A circle drawn for a filter with a hand-written 'option allowed_region' replaces it,
        // which the warning at page load has announced
        return this.applyChange(this.checkRegion.bind(this, sid, region)).then(function() {
            self.ackRegion(token, sid, region);
            if (disabled)
                self.showApplied(sid, before, _('Applied. Filter %s is disabled.').format(name), [ enableAction(sid) ]);
            else
                self.showApplied(sid, before);
        });
    },

    // Apply enabled=1 for a filter, from the toast after drawing. A refusal by checkStaged()
    // offers Enable again, and Undo while the toast's change is the last one
    enableFilter: function(sid) {
        var self = this, u = this.undo;

        return this.enqueue(null, sid, function() {
            if (!isGeoFilter(sid) || uci.get('geomate', sid, 'enabled') === '1')
                return;
            // A filter without a region blocks all its traffic in strict mode: the Geo Filters page decides that
            if (!self.regionList(sid).length)
                return self.sendMessageToMap('toast', {
                    text: _('Draw a circle for filter %s before enabling it.').format(self.filterName(sid))
                });

            var before = filterOptions(sid);
            uci.set('geomate', sid, 'enabled', '1');
            return self.applyChange(function() {
                if (uci.get('geomate', sid, 'enabled') !== '1')
                    throw failure(_('Could not enable filter %s.').format(self.filterName(sid)));
            }).then(function() {
                self.sendMessageToMap('filterChanged', self.filterInfo(sid));
                self.showApplied(sid, before);
            });
        }, function(reason) {
            self.sendToast(reason, u, enableAction(sid));
        });
    },

    // uci.save() resolves even when the session refused a change or the section is gone (deleted
    // in another tab), then reloads the configuration: commit only when it holds the region
    checkRegion: function(sid, region) {
        if (this.regionList(sid).indexOf(region) < 0)
            throw failure(_('Could not save the circle of filter %s.').format(this.filterName(sid)));
    },

    // Confirm an applied circle to the map, which learns a new filter's id this way. A dialog
    // picks from the configuration as loaded now: when the map knows that id under another
    // name (ids shifted), it gets all filters again instead of relabelling the stale entry
    ackRegion: function(token, sid, region) {
        var info = this.filterInfo(sid), known = this.sidNames[sid];

        this.sidNames[sid] = info.name;
        this.sendMessageToMap('regionSaved', Object.assign(info, { token: token, region: region }));
        if (known !== undefined && known !== info.name)
            this.pushFilters();
    },

    rejectRegion: function(token, sid, reason) {
        reason = reason || _('Circle of filter %s not found. Reload the page.').format(this.filterName(sid));
        ui.addNotification(null, E('p', {}, [ reason ]), 'warning');
        this.sendMessageToMap('regionRejected', { token: token, reason: reason });
    },

    // A circle was moved or resized: replace the stored string it was loaded with
    replaceRegion: function(token, sid, oldRegion, region) {
        var self = this,
            list = this.regionList(sid),
            index = list.indexOf(oldRegion),
            before = filterOptions(sid);

        if (!validRegion(region))
            return this.rejectRegion(token, sid, _('Invalid circle %s').format(region));
        if (index < 0)
            return this.rejectRegion(token, sid);

        list[index] = region;
        uci.set('geomate', sid, 'allowed_region', list);
        return this.applyChange(this.checkRegion.bind(this, sid, region)).then(function() {
            self.ackRegion(token, sid, region);
            self.showApplied(sid, before);
        });
    },

    // A circle was deleted; the last one of a filter needs a decision about the filter. After
    // that dialog the configuration is loaded again, and the list and Undo's copy come from it
    removeRegion: function(token, sid, oldRegion) {
        var self = this,
            list = this.regionList(sid),
            effect = (list.length > 1) ? null : this.lastRegionEffect(sid);

        if (list.indexOf(oldRegion) < 0)
            return this.rejectRegion(token, sid);

        return ((list.length > 1) ? Promise.resolve('keep') : this.confirmLastRegion(sid).then(function(choice) {
            return choice && self.loadConfig().then(function() { return choice; });
        })).then(function(choice) {
            if (!choice)
                return self.sendMessageToMap('regionRejected', { token: token, reason: '' });
            if (self.movedFilter(sid, self.sidNames[sid]))
                throw filtersChanged();

            var before = filterOptions(sid), index, text = null;

            list = self.regionList(sid);
            index = list.indexOf(oldRegion);
            if (index < 0)
                return self.rejectRegion(token, sid);
            list.splice(index, 1);
            // A circle added in the meantime: no longer the last one, the filter stays as it is
            if (list.length && choice == 'disable')
                text = _('Applied. Filter %s has another circle now and stays enabled.').format(self.filterName(sid));
            if (list.length)
                choice = 'keep';
            // The dialog showed another effect, e.g. the filter was enabled in the meantime
            else if (choice == 'keep' && self.lastRegionEffect(sid) !== effect)
                throw filtersChanged();

            uci.set('geomate', sid, 'allowed_region', list.length ? list : null);
            if (choice == 'disable')
                uci.set('geomate', sid, 'enabled', '0');

            return self.applyChange(function() {
                // As in checkRegion: the reloaded list must have lost the circle
                if (self.regionList(sid).length !== list.length)
                    throw failure(_('Could not delete the circle of filter %s.').format(self.filterName(sid)));
            }).then(function() {
                self.sendMessageToMap('regionRemoved', { token: token });
                // The legend and the draw menu show the filter as disabled now
                if (choice == 'disable')
                    self.sendMessageToMap('filterChanged', self.filterInfo(sid));
                self.showApplied(sid, before, text);
            });
        });
    },

    // What deleting the last circle of a filter means while it stays as it is, with %s for its name
    lastRegionEffect: function(sid) {
        var monitor = (uci.get('geomate', 'global', 'operational_mode') || 'dynamic') === 'monitor',
            strict = uci.get('geomate', 'global', 'strict_mode') === '1';

        if (uci.get('geomate', sid, 'enabled') !== '1')
            return _('Filter %s is disabled and will have no circles.');
        if (strict && !monitor)
            return _('Strict mode is on, so filter %s will block every server except its allowed IPs.');
        return _('Without circles, filter %s blocks no servers.');
    },

    // Resolves with 'disable', 'keep' or null (cancelled)
    confirmLastRegion: function(sid) {
        var name = this.filterName(sid),
            enabled = uci.get('geomate', sid, 'enabled') === '1',
            effect = this.lastRegionEffect(sid);

        return new Promise(function(resolve) {
            var button = function(cls, label, choice) {
                return E('button', { 'class': 'btn ' + cls, 'click': function() { ui.hideModal(); resolve(choice); } }, [ label ]);
            };
            var preferred = enabled
                ? button('cbi-button-negative', _('Delete and disable'), 'disable')
                : button('cbi-button-negative', _('Delete'), 'keep');
            // No null entries: dom.append in LuCI 23.05 and 26.036 renders them as the text "null"
            var buttons = [ button('', _('Cancel'), null), ' ' ];
            if (enabled)
                buttons.push(button('cbi-button-action', _('Delete'), 'keep'), ' ');
            buttons.push(preferred);

            ui.showModal(_('Delete the last circle of %h?').format(name), [
                E('p', {}, [ effect.format(name) ]),
                E('div', { 'class': 'right' }, buttons)
            ]);
            preferred.focus();
        });
    },

    // A new circle was drawn for a new filter: name it, or choose a filter. The circle stays
    // pending on the map until this modal ends with regionSaved, regionDiscarded or regionRejected.
    // pick: NEW_FILTER opens with the name field focused, '' with the filter list
    openFilterModal: function(token, region, pick) {
        var self = this,
            f = this.filterChoices(_('-- Please choose --')),
            sections = f.sections,
            initial = {},
            sid = null;

        if (!validRegion(region))
            return Promise.reject(new Error(_('Invalid circle %s').format(region)));

        // Existing filter names match without regard to case
        var findFilter = function(name) {
            name = name.toLowerCase();
            return sections.find(function(s) { return s.name.toLowerCase() === name; }) || null;
        };

        // Every filter in config order, then 'New filter…'; without filters the name field shows at once
        var filterW = new ui.Select((pick === NEW_FILTER || !sections.length) ? NEW_FILTER : '', f.choices, { sort: f.sort });

        var nameW = new ui.Textfield('', {
            optional: false,
            placeholder: _('New filter name'),
            validate: function(v) {
                v = (v || '').trim();
                if (v === '')
                    return _('Expecting: %s').format(_('non-empty value'));
                return FILTER_NAME_RE.test(v) || _('Use only letters, digits, spaces, "_", "." and "-"');
            }
        });

        var ipPlaceholder = _('192.168.1.0/24 or !192.168.1.128/25'),
            portPlaceholder = _('25200 25300 or 27015-27020');

        var fields = {
            enabled: new ui.Checkbox('1', { value_enabled: '1', value_disabled: '0' }),
            protocol: new ui.Select('udp', { tcp: 'TCP', udp: 'UDP' }, {}),
            src_ip: new ui.Textfield('', { datatype: 'list(neg(ip4addr))', placeholder: ipPlaceholder }),
            src_port: new ui.Textfield('', { datatype: 'list(neg(portrange))', placeholder: portPlaceholder }),
            dest_port: new ui.Textfield('', { datatype: 'list(neg(portrange))', placeholder: portPlaceholder }),
            allowed_ip: new ui.DynamicList([], null, { datatype: 'list(neg(ip4addr))', placeholder: ipPlaceholder }),
            ip_expiry_days: new ui.Textfield('', { datatype: 'uinteger', placeholder: '0' }),
            ip_list: new ui.Textfield('', {
                validate: function(v) { return v === '' || v.charAt(0) === '/' || _('Expecting an absolute path'); }
            })
        };

        var labels = {
            enabled: _('Enable'),
            protocol: _('Protocol'),
            src_ip: _('Source IP'),
            src_port: _('Source Port'),
            dest_port: _('Destination Port'),
            allowed_ip: _('Allowed IPs'),
            ip_expiry_days: _('IP Expiry (Days)'),
            ip_list: _('IP List File')
        };

        var value = function(k) {
            var v = fields[k].getValue();
            return Array.isArray(v) ? v.filter(function(x) { return x.trim() !== ''; }) : String(v == null ? '' : v).trim();
        };

        var isNew = function() {
            return filterW.getValue() === NEW_FILTER;
        };

        // The filter the region goes to: the picked one, or an existing one the typed name matches
        var target = function() {
            var picked = filterW.getValue(), typed = (nameW.getValue() || '').trim();
            if (picked === NEW_FILTER)
                return typed ? findFilter(typed) : null;
            return sections.find(function(s) { return s['.name'] === picked; }) || null;
        };

        var currentName = function() {
            var sec = target();
            return sec ? sec.name : isNew() ? (nameW.getValue() || '').trim() : '';
        };

        var suggestedList = function() {
            var name = currentName();
            return name ? ipListPath(name) : '';
        };

        // The values typed for a new filter while the fields show an existing one
        var draft = null;

        // Show the settings of the chosen filter; for a new one the values typed for it, or the defaults
        var fill = function(sec) {
            Object.keys(fields).forEach(function(k) {
                var v = sec ? sec[k] : null;

                if (!sec && draft)
                    v = draft[k];
                else if (k == 'enabled')
                    v = (!sec || v === '1') ? '1' : '0';
                else if (k == 'protocol')
                    v = sec ? v : 'udp';
                else if (k == 'allowed_ip')
                    v = L.toArray(v);
                else
                    v = Array.isArray(v) ? v.join(' ') : (v == null ? '' : v);

                fields[k].setValue(v);
                initial[k] = value(k);
            });
        };

        // Another filter that already uses the list this filter would get (names can share a slug)
        var listOwner = function() {
            var path = value('ip_list') || suggestedList(), sec = target();
            return !path ? null : uci.sections('geomate', 'geo_filter').find(function(s) {
                return (!sec || s['.name'] !== sec['.name']) && s.ip_list === path;
            }) || null;
        };

        var hint = E('div', { 'class': 'cbi-value-description' }),
            status = E('div', { 'class': 'cbi-value-description' }),
            listHint = E('div', { 'class': 'cbi-value-description' }),
            geoLink = E('a', { 'href': L.url('admin/services/geomate/geofilters') }, [ _('Geo Filters') ]);

        var nameNode = E('div', { 'style': 'margin-top: 8px' }, [ nameW.render() ]);

        // Show the name field for a new filter, and the settings of the filter the region goes to
        var update = function() {
            var name = currentName(),
                sec = target(),
                secId = sec ? sec['.name'] : null;

            nameNode.style.display = isNew() ? '' : 'none';

            if (secId !== sid) {
                // A typed name can match an existing filter for a moment: keep the new filter's values
                if (sid === null)
                    draft = Object.keys(fields).reduce(function(d, k) { d[k] = fields[k].getValue(); return d; }, {});
                sid = secId;
                fill(sec);
            }

            fields.ip_list.node.querySelector('input').placeholder = suggestedList();
            // The page opens the dialog of an existing filter at once
            geoLink.href = L.url('admin/services/geomate/geofilters') + (secId ? '#edit=' + encodeURIComponent(secId) : '');
            // No null entries: dom.append in LuCI 23.05 and 26.036 renders them as the text "null"
            var hintText = [ !sec
                ? _('Creates the filter %s.').format(name)
                : (sec.enabled === '1')
                    ? _('Adds the circle to filter %s.').format(sec.name)
                    : _('Adds the circle to the disabled filter %s.').format(sec.name) ];
            if (sec && typeof sec.allowed_region == 'string')
                hintText.push(' ' + _('It replaces "option allowed_region %s".').format(sec.allowed_region));
            dom.content(hint, (!name || (!sec && !FILTER_NAME_RE.test(name))) ? null : hintText);

            var owner = name ? listOwner() : null;
            dom.content(listHint, owner ? [ _('Filter %s already uses this IP list.')
                .format(owner.name || owner['.name']) ] : null);
        };

        var writeList = function(path, file) {
            dom.content(status, [ _('Uploading...') ]);
            return file.text().then(function(text) {
                return fs.write(path, text);
            }).then(function() {
                fields.ip_list.setValue(path);
                dom.content(status, [ _('Uploaded %s to %s.').format(file.name, path) ]);
                update();
            }).catch(function(err) {
                dom.content(status, [ _('Failed to upload file: %s').format(errorText(err)) ]);
            });
        };

        // Upload to a new file at once; an existing list is only replaced after confirmation
        var uploadList = function(file) {
            var path = value('ip_list') || suggestedList();

            // A file directly in /etc/geomate.d; '.' and '..' name a directory
            if (!/^\/etc\/geomate\.d\/(?!\.\.?$)[^\/]+$/.test(path))
                return dom.content(status, [ _('Choose a filter name or a list file in /etc/geomate.d/ first.') ]);

            // Geo data files and the updater's md5 registries live there too
            if (/\.(json|md5)$/i.test(path))
                return dom.content(status, [ _('%s is not an IP list file.').format(path) ]);

            fs.stat(path).then(function() {
                dom.content(status, [
                    _('%s already exists. Replace it with %s?').format(path, file.name), ' ',
                    E('button', { 'class': 'btn cbi-button-negative', 'click': function() { writeList(path, file); } }, [ _('Replace') ]), ' ',
                    E('button', { 'class': 'btn', 'click': function() {
                        dom.content(status, [ _('Upload cancelled.') ]);
                    } }, [ _('Cancel') ])
                ]);
            }, function(err) {
                if (err && err.name == 'NotFoundError')
                    return writeList(path, file);
                dom.content(status, [ _('Cannot check %s: %s').format(path, errorText(err)) ]);
            });
        };

        var fileInput = E('input', { 'type': 'file', 'style': 'display: none', 'change': function(ev) {
            var file = ev.target.files[0];
            ev.target.value = '';
            if (file)
                uploadList(file);
        } });

        var row = function(label, node, extra) {
            return E('div', { 'class': 'cbi-value' }, [
                E('label', { 'class': 'cbi-value-title', 'style': 'width:33%' }, [ label ]),
                E('div', { 'class': 'cbi-value-field', 'style': 'margin-left:33%' }, [ node ].concat(extra || []))
            ]);
        };

        var filterNode = filterW.render();
        filterNode.addEventListener('widget-change', update);
        // 'input' also covers paste and autofill, which fire no keyup
        nameNode.querySelector('input').addEventListener('input', update);

        var body = E('div', { 'class': 'cbi-section-node' }, [ row(_('Filter'), filterNode, [ nameNode, hint ]) ]);
        Object.keys(fields).forEach(function(k) {
            body.appendChild(row(labels[k], fields[k].render(), (k != 'ip_list') ? null : [
                E('div', { 'style': 'margin-top: 8px' }, [
                    E('button', { 'class': 'btn cbi-button-neutral', 'click': function() {
                        if (!currentName())
                            return dom.content(status, [ _('Please specify a filter name first.') ]);
                        fields.ip_list.setValue(suggestedList());
                        dom.content(status, [ _('Geomate creates a missing file at its next start.') ]);
                        update();
                    } }, [ _('Create Empty List') ]), ' ',
                    E('button', { 'class': 'btn cbi-button-action', 'click': function() { fileInput.click(); } }, [ _('Upload IP List') ]),
                    fileInput
                ]),
                status,
                listHint
            ]));
        });
        fields.ip_list.node.querySelector('input').addEventListener('input', update);

        return new Promise(function(resolve) {
            var cancel = function() {
                ui.hideModal();
                self.sendMessageToMap('regionDiscarded', { token: token });
                resolve();
            };

            var save = function() {
                // The fields already show the target filter: update() runs on every pick and keystroke
                var picked = filterW.getValue(), sec = target(), name = currentName();

                Object.keys(fields).forEach(function(k) { fields[k].triggerValidation(); });
                if (isNew())
                    nameW.triggerValidation();

                if (!picked)
                    dom.content(hint, [ _('Choose a filter.') ]);

                // The hidden name field of an earlier 'New filter…' pick does not count
                if (!picked || (isNew() && !nameW.isValid()) || !name ||
                    Object.keys(fields).some(function(k) {
                        return !fields[k].isValid() || fields[k].node.querySelector('.cbi-input-invalid');
                    }))
                    return;

                var values = {};
                Object.keys(fields).forEach(function(k) { values[k] = value(k); });
                values.ip_list = values.ip_list || suggestedList();

                // The dialog may have stayed open while another tab applied changes: write on
                // the configuration as the session holds it now
                ui.hideModal();
                resolve(self.loadConfig().then(function() {
                    return self.saveRegion(token, region, name, sec, values, initial);
                }));
            };

            ui.showModal((pick === NEW_FILTER) ? _('New filter') : _('New circle'), [
                E('div', { 'class': 'cbi-map' }, [ E('div', { 'class': 'cbi-section' }, [ body ]) ]),
                E('p', {}, [
                    _('More options:'), ' ',
                    geoLink
                ]),
                E('div', { 'class': 'right' }, [
                    E('button', { 'class': 'btn cbi-button-neutral', 'click': cancel }, [ _('Cancel') ]), ' ',
                    E('button', { 'class': 'btn cbi-button-positive', 'click': save }, [ _('Save') ])
                ])
            ]);

            update();
            (isNew() ? nameNode.querySelector('input') : filterNode.querySelector('select')).focus();
        });
    },

    // Apply a drawn region from the modal. An existing filter only gets the options the user
    // changed; a new one gets every non-empty option, its enabled flag comes from the checkbox.
    // The caller has loaded the configuration again after the dialog, sec is the dialog's copy:
    // its id may name another filter or none now (movedFilter), or a filter of the new name may
    // exist (names match without regard to case, as in the dialog)
    saveRegion: function(token, region, name, sec, values, initial) {
        var self = this, sid, before = null;

        if (sec && uci.get('geomate', sec['.name'], 'name') !== sec.name)
            throw filtersChanged();
        if (!sec && uci.sections('geomate', 'geo_filter').some(function(s) {
            return String(s.name || '').toLowerCase() === name.toLowerCase();
        }))
            throw failure(_('Not applied: filter %s was created in the meantime.').format(name));

        if (sec) {
            sid = sec['.name'];
            before = filterOptions(sid);
            var list = this.regionList(sid);
            if (list.indexOf(region) < 0)
                list.push(region);
            uci.set('geomate', sid, 'allowed_region', list);

            Object.keys(values).forEach(function(k) {
                if (L.toArray(values[k]).join(' ') !== L.toArray(initial[k]).join(' '))
                    uci.set('geomate', sid, k, isEmpty(values[k]) ? null : values[k]);
            });
        }
        else {
            sid = uci.add('geomate', 'geo_filter');
            uci.set('geomate', sid, 'name', name);
            uci.set('geomate', sid, 'allowed_region', [ region ]);

            Object.keys(values).forEach(function(k) {
                if (!isEmpty(values[k]))
                    uci.set('geomate', sid, k, values[k]);
            });
        }

        return this.applyChange(function() {
            // uci.save() replaced the new%06x id; find the section by name and region
            if (!sec) {
                var found = uci.sections('geomate', 'geo_filter').find(function(s) {
                    return s.name === name && L.toArray(s.allowed_region).indexOf(region) > -1;
                });
                if (!found)
                    throw failure(_('Filter %s not found after saving.').format(name));
                sid = found['.name'];
            }
            self.checkRegion(sid, region);
        }).then(function() {
            self.ackRegion(token, sid, region);
            self.showApplied(sid, before);
        });
    },

    // Fill the connections table. Country, city and ISP come from luci.geomate's geo lookup;
    // older backends and cache entries have none of them, the cells then show '–'
    updateActiveConnectionsList: function() {
        var table = this.connectionsTable;
        if (!table || !this.nodes.connectionsTitle) return;

        // Skip any connection object lacking filter_name to avoid errors
        var list = this.connections.filter(function(conn) {
            return conn && conn.filter_name;
        });

        this.nodes.connectionsTitle.textContent = _('Active connections (%d)').format(list.length);

        table.update(list.map(function(conn) {
            // A failed lookup arrives as an empty array
            var geo = (conn.geo && typeof conn.geo == 'object' && !Array.isArray(conn.geo)) ? conn.geo : {},
                status = connectionStatus(conn, geo);

            // Every cell is an element: names and provider strings never run as markup
            return [
                textCell(conn.dst),
                textCell(conn.filter_name),
                E('span', { 'class': 'gm-status gm-status--' + status[0], 'data-value': status[0] }, [ status[1] ]),
                textCell(geo.country, geo.countryCode),
                textCell(geo.city),
                textCell(geo.isp, geo.org)
            ];
        }));
    },

    /**
     * Check for updates, one call at a time. On page load and in the hourly poll a fresh cached
     * result (cachedVersionCheck) is shown instead of asking GitHub again.
     * @param {boolean} force - Ask GitHub now, whatever the cache holds ('Check again').
     */
    checkForUpdates: function(force) {
        var self = this, cached = (force === true) ? null : cachedVersionCheck();

        if (this.versionBusy || !this.nodes)
            return this.versionBusy || Promise.resolve();

        if (cached) {
            this.versionInfo = versionState(cached);
            this.showVersions();
            return Promise.resolve();
        }

        // LuCI batches the RPC calls of one animation frame into one HTTP request. check_version
        // waits for GitHub, so it starts later than the polls and does not delay their answers
        this.versionBusy = new Promise(function(resolve) {
            window.setTimeout(resolve, 500);
        }).then(function() {
            // -i: past the backend's own 10-minute cache of the GitHub answer as well
            return fs.exec('/etc/init.d/geomate', (force === true) ? [ 'check_version', '-i' ] : [ 'check_version' ]);
        }).then(function(result) {
            var entry = { stdout: result.stdout || '', stderr: result.stderr || '', code: result.code, at: Date.now(), ui: UI_VERSION };

            storeVersionCheck(entry);
            self.versionInfo = versionState(entry);
        }).catch(function(error) {
            // No answer: a timeout means GitHub was slow, anything else that the command did
            // not run (e.g. no permission). Nothing to cache; known versions stay
            var known = self.versionInfo || versionState({}),
                timeout = (error && error.name == 'TimeoutError') || /timed out/i.test(errorText(error));

            self.versionInfo = Object.assign({}, known, { state: 'failed', update: null, limited: false, error: timeout ? null : errorText(error) });
        }).finally(function() {
            self.versionBusy = null;
            self.showVersions();
        });

        this.showVersions();
        return this.versionBusy;
    }
});
