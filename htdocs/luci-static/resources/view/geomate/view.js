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

// Same bounds as parseRegion in map.html, so the map can load every region the view stages
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

// Suggested IP list path for a filter name
function ipListPath(name) {
    return '/etc/geomate.d/' + name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_servers.txt';
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

return view.extend({
    // Every region action stages at once: there is nothing left for a Save button to do
    handleSave: null,

    pending: {},        // last staged changes (callUciChanges)
    busy: null,         // promise chain that serializes region actions
    reported: {},       // region problems already shown, so a new map iframe does not repeat them
    connections: [],    // last getGeomateConnections result
    connectionsAt: null,    // time of the last getGeomateConnections reply
    connectionsFailed: 0,   // failed getGeomateConnections requests since that reply
    status: null,       // last getStatus result, null when it failed
    statusLoaded: false,    // a getStatus reply (or failure) has arrived
    health: null,       // last getHealthCheck result, null when it failed
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

    // Plain nodes, no form.Map: the footer buttons and the polls never render the map iframe again
    render: function(data) {
        var configLoaded = data[0] != null;

        this.pending = data[1] || {};
        // hasViewPermission() is what the footer uses without a form.Map to disable its buttons
        this.readonly = !L.hasViewPermission() || !configLoaded;
        this.nodes = {};
        this.focusSid = this.takeFocusHash();

        if (!configLoaded)
            ui.addNotification(null, E('p', {}, [
                _('Could not load the geomate configuration. Reload the page.')
            ]), 'error');

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

        return (sid && (uci.get('geomate', sid) || {})['.type'] === 'geo_filter') ? sid : null;
    },

    renderStatus: function() {
        var n = this.nodes;

        n.indicator = E('div', {
            id: 'service-status-indicator',
            style: 'width: 12px; height: 12px; border-radius: 50%; margin-right: 8px;'
        });
        n.state = E('span', { id: 'service-status-text', style: 'margin: 0; font-weight: bold;' });
        n.health = E('span', { id: 'health-check-status', style: 'font-size: 13px; margin-left: 8px;' });
        n.loading = E('span', {
            id: 'geomate-loading-indicator',
            style: 'display: none; color: orange; margin-left: 8px;'
        }, [ _('Loading GeoFilter data ...') ]);
        n.stale = E('span', {
            id: 'geomate-connections-stale',
            style: 'display: none; color: orange; margin-left: 8px;'
        });
        n.mode = E('p', { id: 'operational-mode-text', style: 'margin: 0;' });
        n.version = E('span', { id: 'version-display', style: 'color: #6b7280;' }, [ _('Loading version...') ]);
        n.update = E('span', { id: 'version-update-status', style: 'margin-left: 8px; font-style: italic;' });

        return E('div', { style: 'display: flex; flex-direction: column;' }, [
            // Service status, health checks, loading and stale connections in one row. Staged
            // changes: LuCI's own Unsaved Changes indicator in the header
            E('div', { style: 'display: flex; align-items: center; flex-wrap: wrap; gap: 8px;' }, [
                E('div', { style: 'display: flex; align-items: center;' }, [ n.indicator, n.state ]),
                n.health,
                n.loading,
                n.stale
            ]),
            // Operational mode and versions
            E('div', {
                id: 'operational-mode-container',
                style: 'margin-top: 8px; display: flex; justify-content: space-between; align-items: center;'
            }, [
                n.mode,
                E('div', { style: 'font-size: 13px; color: #6b7280;' }, [ n.version, n.update ])
            ])
        ]);
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

    // Section below the map: a header "Active connections (n)" with a Show/Hide button, and the
    // table, collapsed until shown
    renderConnections: function() {
        var n = this.nodes;

        var style = E('style', {}, `
            /* No side margin, whatever the theme gives a section: the same edges as the map */
            #active-connections-container { margin: 12px 0 0; }
            #active-connections-container .gm-connections-head { display: flex; flex-wrap: nowrap; align-items: center; justify-content: space-between; gap: 8px; }
            /* A theme may give h3 width: 100%, which pushed the button to a second row */
            #active-connections-container .gm-connections-head h3 { flex: 1 1 0; min-width: 0; width: auto; margin: 0; }
            #active-connections-container .gm-connections-head .btn { flex: none; margin: 0; }
            #active-connections-container .gm-connections-wrap { max-height: 400px; overflow: auto; margin-top: 8px; }
            #active-connections-container .gm-connections-wrap[hidden] { display: none; }
            #active-connections-container .table { margin: 0; }
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
            .gm-status--allowed { --gm-status-color: var(--success, var(--success-color-high, var(--success-color, #1a7f37))); }
            .gm-status--blocked { --gm-status-color: var(--danger, var(--error-color-high, var(--danger-color, #cf222e))); }
            .gm-status--whitelist { --gm-status-color: var(--primary, var(--primary-color-high, var(--main-bright-color, #1a6fd1))); }
            .gm-status--untracked, .gm-status--unknown { --gm-status-color: #8c959f; }
        `);

        // Sortable columns; the theme styles the table like every LuCI table
        this.connectionsTable = new ui.Table(
            [ _('IP'), _('Filter'), _('Status'), _('Country'), _('City'), _('ISP') ],
            { id: 'geomate-connections', sortable: true, placeholder: _('No active connections') },
            E('em', {}, [ _('Loading connections…') ])
        );

        n.connectionsTitle = E('h3', {}, [ _('Active connections') ]);
        n.connectionsWrap = E('div', { 'class': 'gm-connections-wrap', 'id': 'gm-connections-wrap' }, [ this.connectionsTable.render() ]);
        n.connectionsWrap.hidden = true;
        n.toggle = E('button', {
            'class': 'btn cbi-button cbi-button-neutral',
            'aria-expanded': 'false',
            'aria-controls': 'gm-connections-wrap',
            'click': L.bind(this.toggleConnections, this)
        }, [ _('Show') ]);

        n.connections = E('div', { 'class': 'cbi-section', 'id': 'active-connections-container' }, [
            style,
            E('div', { 'class': 'gm-connections-head' }, [ n.connectionsTitle, n.toggle ]),
            n.connectionsWrap
        ]);

        return n.connections;
    },

    // Show or hide the connections table; the map gets smaller while it is shown
    toggleConnections: function() {
        var n = this.nodes,
            show = n.connectionsWrap.hidden;

        n.connectionsWrap.hidden = !show;
        n.toggle.textContent = show ? _('Hide') : _('Show');
        n.toggle.setAttribute('aria-expanded', show ? 'true' : 'false');
        n.frame.classList.toggle('gm-map-frame--short', show);
        if (show)
            n.connections.scrollIntoView({ behavior: 'smooth' });
    },

    // Show the last status and health check
    updateStatus: function() {
        var n = this.nodes,
            st = this.status,
            checks = this.health && this.health.checks,
            running = !!(st && st.running);

        if (!n)
            return;

        n.indicator.style.backgroundColor = st ? (running ? 'green' : 'red') : 'gray';
        n.state.textContent = st ? (running ? _('Running') : _('Not Running'))
            : (this.statusLoaded ? _('Status unknown') : _('Loading status...'));
        n.loading.style.display = (st ? st.loading : (this.health && this.health.loading)) ? 'inline' : 'none';

        // Compact health check display; messages stay text, never markup
        var checkLabels = {
            'config': _('Config'),
            'files': _('Files'),
            'datadir': _('Data'),
            'service': _('Autostart'),
            'nft': _('nftables')
        };
        var icons = {
            'error': ['✗', '#ef4444'],
            'warning': ['⚠', '#f59e0b'],
            'info': ['○', '#6b7280']
        };
        dom.content(n.health, !checks ? null : Object.keys(checkLabels).filter(function(key) {
            return checks[key];
        }).map(function(key) {
            var icon = icons[checks[key].status] || ['✓', '#10b981'];
            return E('span', { 'style': 'margin-right: 10px;', 'title': checks[key].message || '' }, [
                E('span', { 'style': 'color: ' + icon[1] + ';' }, [ icon[0] ]),
                ' ' + checkLabels[key]
            ]);
        }));

        // Operational mode of the committed configuration, the one the service runs with
        var mode = st && st.operational_mode, modeText = '', modeStyle = '';
        if (mode === 'monitor') {
            modeText = _('Mode: Monitor Only - Connections are tracked but NOT blocked');
            modeStyle = 'color: orange; font-weight: bold;';
        } else if (mode === 'static') {
            modeText = _('Mode: Static - Using predefined IP lists');
            modeStyle = 'color: blue;';
        } else if (mode) {
            modeText = _('Mode: Dynamic - Building IP lists automatically');
            modeStyle = 'color: green;';
        }
        n.mode.textContent = modeText;
        n.mode.style.cssText = 'margin: 0; ' + modeStyle;

        // A single failed request keeps the last list silently; a lasting failure becomes visible
        var stale = this.connectionsFailed >= CONNECTIONS_STALE_AFTER;
        n.stale.style.display = stale ? 'inline' : 'none';
        n.stale.textContent = !stale ? '' : this.connectionsAt
            ? _('Connections not updated since %s').format(new Date(this.connectionsAt).toLocaleTimeString())
            : _('Connections unavailable');
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
                self.updateStatus();
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

        // Without write access nothing is staged; the map has no drawing tools then anyway
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
            this.enqueue(d.token, function() { return self.addDrawnRegion(d.token, d.region, d.sid); });
            break;
        case 'toastAction':
            if (d.name == 'enableFilter')
                this.enableFilter(d.sid);
            break;
        case 'regionEdited':
            this.enqueue(d.token, function() { return self.replaceRegion(d.token, d.sid, d.oldRegion, d.region); });
            break;
        case 'regionDeleted':
            this.enqueue(d.token, function() { return self.removeRegion(d.token, d.sid, d.oldRegion); });
            break;
        case 'regionInvalid':
            this.warnOnce(d.sid + ' ' + d.region, _('Filter %s has an invalid circle "%s". Fix it on the Geo Filters page.')
                .format(this.filterName(d.sid), d.region));
            break;
        }
    },

    // Run region actions one after another: uci.save() reloads the configuration, so a second
    // action must not read it in between. A failed action hands its region back to the map.
    enqueue: function(token, fn) {
        var self = this;
        this.busy = Promise.resolve(this.busy).then(fn).catch(function(err) {
            var reason = _('Change failed: %s. Reload the page.').format(errorText(err));
            ui.addNotification(null, E('p', {}, [ reason ]), 'error');
            self.sendMessageToMap('regionRejected', { token: token, reason: reason });
            // A failed uci.save() keeps its changes in memory; drop them so a later save does not stage them
            uci.unload('geomate');
            return L.resolveDefault(uci.load('geomate'));
        });
        return this.busy;
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

    // Send every filter to the map, also disabled ones; done once per mapReady
    pushFilters: function() {
        var self = this, staged = {};

        L.toArray((this.pending || {}).geomate).forEach(function(change) {
            staged[change[1]] = true;
        });

        this.sendMessageToMap('setFilters', {
            filters: uci.sections('geomate', 'geo_filter').map(function(s) {
                if (typeof s.allowed_region == 'string')
                    self.warnOnce(s['.name'] + ' option', _('Filter %s has "option allowed_region %s", which the map cannot show and the service start skips. A circle drawn for this filter replaces it.')
                        .format(s.name || s['.name'], s.allowed_region));
                return Object.assign(self.filterInfo(s['.name']), { regions: self.regionList(s['.name']) });
            }),
            stagedSids: Object.keys(staged)
        });
    },

    // Stage the in-memory changes in the LuCI session. LuCI's Unsaved Changes indicator in the
    // header counts them, the map dashes the circles of the changed filters. toast: { text,
    // action: { name, sid, label } }, an optional note inside the map (a LuCI notification would
    // push the page and the map toolbar down)
    stage: function(toast) {
        var self = this;
        return uci.save().then(function() {
            return L.resolveDefault(callUciChanges(), null);
        }).then(function(changes) {
            if (changes)
                self.pending = changes;
            if (toast)
                self.sendMessageToMap('toast', toast);
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

        var name = this.filterName(sid),
            list = this.regionList(sid),
            disabled = uci.get('geomate', sid, 'enabled') !== '1';

        if (list.indexOf(region) < 0)
            list.push(region);
        uci.set('geomate', sid, 'allowed_region', list);

        // Drawing never enables a filter; a disabled one gets a one-click offer. An enabled filter
        // needs no note: the dashed circle and LuCI's Unsaved Changes show the change. A circle
        // drawn for a filter with a hand-written 'option allowed_region' replaces it, which the
        // warning at page load has announced
        return this.stage(!disabled ? null : {
            text: _('Filter %s is disabled.').format(name),
            action: { name: 'enableFilter', sid: sid, label: _('Enable') }
        }).then(this.ackRegion.bind(this, token, sid, region));
    },

    // Stage enabled=1 for a filter, from the toast after drawing
    enableFilter: function(sid) {
        var self = this;

        return this.enqueue(null, function() {
            if (!isGeoFilter(sid) || uci.get('geomate', sid, 'enabled') === '1')
                return;
            // A filter without a region blocks all its traffic in strict mode: the Geo Filters page decides that
            if (!self.regionList(sid).length)
                return self.sendMessageToMap('toast', {
                    text: _('Draw a circle for filter %s before enabling it.').format(self.filterName(sid))
                });

            uci.set('geomate', sid, 'enabled', '1');
            return self.stage().then(function() {
                self.sendMessageToMap('filterChanged', self.filterInfo(sid));
            });
        });
    },

    // uci.save() resolves even when the session refused a change or the section is gone (deleted
    // in another tab), then reloads the configuration: confirm only a region that it holds
    ackRegion: function(token, sid, region) {
        if (this.regionList(sid).indexOf(region) < 0)
            return this.rejectRegion(token, sid, _('Could not save the circle of filter %s. Reload the page.').format(this.filterName(sid)));
        this.sendMessageToMap('regionSaved', Object.assign(this.filterInfo(sid), { token: token, region: region }));
    },

    rejectRegion: function(token, sid, reason) {
        reason = reason || _('Circle of filter %s not found. Reload the page.').format(this.filterName(sid));
        ui.addNotification(null, E('p', {}, [ reason ]), 'warning');
        this.sendMessageToMap('regionRejected', { token: token, reason: reason });
    },

    // A circle was moved or resized: replace the stored string it was loaded with
    replaceRegion: function(token, sid, oldRegion, region) {
        var list = this.regionList(sid),
            index = list.indexOf(oldRegion);

        if (!validRegion(region))
            return this.rejectRegion(token, sid, _('Invalid circle %s').format(region));
        if (index < 0)
            return this.rejectRegion(token, sid);

        list[index] = region;
        uci.set('geomate', sid, 'allowed_region', list);
        return this.stage().then(this.ackRegion.bind(this, token, sid, region));
    },

    // A circle was deleted; the last one of a filter needs a decision about the filter
    removeRegion: function(token, sid, oldRegion) {
        var self = this,
            list = this.regionList(sid),
            index = list.indexOf(oldRegion);

        if (index < 0)
            return this.rejectRegion(token, sid);

        list.splice(index, 1);

        return (list.length ? Promise.resolve('keep') : this.confirmLastRegion(sid)).then(function(choice) {
            if (!choice)
                return self.sendMessageToMap('regionRejected', { token: token, reason: '' });

            uci.set('geomate', sid, 'allowed_region', list.length ? list : null);
            if (choice == 'disable')
                uci.set('geomate', sid, 'enabled', '0');

            return self.stage().then(function() {
                // As in ackRegion: the reloaded list must have lost the circle
                if (self.regionList(sid).length !== list.length)
                    return self.rejectRegion(token, sid, _('Could not delete the circle of filter %s. Reload the page.').format(self.filterName(sid)));
                self.sendMessageToMap('regionRemoved', { token: token });
                // The legend and the draw menu show the filter as disabled now
                if (choice == 'disable')
                    self.sendMessageToMap('filterChanged', self.filterInfo(sid));
            });
        });
    },

    // Resolves with 'disable', 'keep' or null (cancelled)
    confirmLastRegion: function(sid) {
        var name = this.filterName(sid),
            enabled = uci.get('geomate', sid, 'enabled') === '1',
            monitor = (uci.get('geomate', 'global', 'operational_mode') || 'dynamic') === 'monitor',
            strict = uci.get('geomate', 'global', 'strict_mode') === '1',
            effect;

        if (!enabled)
            effect = _('Filter %s is disabled and will have no circles.');
        else if (strict && !monitor)
            effect = _('Strict mode is on, so filter %s will block every server except its allowed IPs.');
        else
            effect = _('Without circles, filter %s blocks no servers.');

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

                ui.hideModal();
                resolve(Promise.resolve().then(function() {
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

    // Stage a drawn region from the modal. An existing filter only gets the options the user
    // changed; a new one gets every non-empty option, its enabled flag comes from the checkbox
    saveRegion: function(token, region, name, sec, values, initial) {
        var self = this, sid;

        if (sec) {
            sid = sec['.name'];
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

        return this.stage().then(function() {
            // uci.save() replaced the new%06x id; find the section by name and region
            if (!sec) {
                var found = uci.sections('geomate', 'geo_filter').find(function(s) {
                    return s.name === name && L.toArray(s.allowed_region).indexOf(region) > -1;
                });
                if (!found)
                    throw new Error(_('Filter %s not found after saving').format(name));
                sid = found['.name'];
            }
            self.ackRegion(token, sid, region);
        });
    },

    // Region actions stage at once; apply what the session has staged after the running one
    handleSaveApply: function(ev, mode) {
        return Promise.resolve(this.busy).then(function() {
            ui.changes.apply(mode == '0');
        });
    },

    // Staged changes live in the LuCI session, so Reset means revert. LuCI reverts every
    // configuration with staged changes at once (like the header's Unsaved Changes dialog).
    // Like Save & Apply it waits for a running region action, so the reset includes its change
    handleReset: function(ev) {
        var self = this;

        return Promise.resolve(this.busy).then(function() {
            return L.resolveDefault(callUciChanges(), null);
        }).then(function(changes) {
            if (changes)
                self.pending = changes;

            var pending = self.pending || {},
                others = Object.keys(pending).filter(function(config) {
                    return config != 'geomate' && L.toArray(pending[config]).length;
                });

            if (!L.toArray(pending.geomate).length) {
                ui.addNotification(null, E('p', {}, [ _('Geomate has no unsaved changes.') ]), 'info');
                return;
            }

            // No null entries: dom.append in LuCI 23.05 and 26.036 renders them as the text "null"
            var body = [ E('p', {}, [ _('Discard all unsaved changes and reload the page?') ]) ];
            if (others.length)
                body.push(E('p', {}, [ _('This also discards the unsaved changes of %s.').format(others.join(', ')) ]));

            ui.showModal(_('Unsaved changes'), body.concat([
                E('div', { 'class': 'right' }, [
                    E('button', { 'class': 'btn cbi-button-neutral', 'click': ui.hideModal }, [ _('Cancel') ]), ' ',
                    E('button', { 'class': 'btn cbi-button-negative', 'click': ui.createHandlerFn(self, function() {
                        ui.hideModal();
                        ui.changes.revert();
                    }) }, [ _('Reset') ])
                ])
            ]));
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

    // Check for updates. check_version asks GitHub: this runs at page load and hourly, one call at a time
    checkForUpdates: function() {
        var self = this;
        var statusElement = this.nodes && this.nodes.update;
        var versionDisplayElement = this.nodes && this.nodes.version;

        if (this.versionBusy) {
            return this.versionBusy;
        }
        
        if (!statusElement) {
            return Promise.resolve();
        }
        
        statusElement.textContent = _('Checking...');
        statusElement.style.color = '#6b7280';

        // LuCI batches the RPC calls of one animation frame into one HTTP request. check_version
        // waits for GitHub, so it starts later than the polls and does not delay their answers
        this.versionBusy = new Promise(function(resolve) {
            window.setTimeout(resolve, 500);
        }).then(function() {
            return fs.exec('/etc/init.d/geomate', ['check_version']);
        }).then(function(result) {
            var output = result.stdout || '';
            var backendUpdateAvailable = false;
            var frontendUpdateAvailable = false;
            var backendCurrentVersion = '';
            var frontendCurrentVersion = '';
            
            // Parse backend and frontend information separately
            var backendMatch = output.match(/Backend versions:[\s\S]*?(Current version: .+[\s\S]*?Latest version: .+)/);
            var frontendMatch = output.match(/Frontend versions:[\s\S]*?(Current version: .+[\s\S]*?Latest version: .+)/);
            
            if (backendMatch) {
                var backendCurrentMatch = backendMatch[1].match(/Current version: (.+)/);
                var backendLatestMatch = backendMatch[1].match(/Latest version: (.+)/);
                if (backendCurrentMatch) {
                    backendCurrentVersion = backendCurrentMatch[1].trim();
                }
                if (backendCurrentMatch && backendLatestMatch && 
                    backendCurrentMatch[1].trim() !== backendLatestMatch[1].trim()) {
                    backendUpdateAvailable = true;
                }
            }
            
            if (frontendMatch) {
                var frontendCurrentMatch = frontendMatch[1].match(/Current version: (.+)/);
                var frontendLatestMatch = frontendMatch[1].match(/Latest version: (.+)/);
                if (frontendCurrentMatch) {
                    frontendCurrentVersion = frontendCurrentMatch[1].trim();
                }
                if (frontendCurrentMatch && frontendLatestMatch && 
                    frontendCurrentMatch[1].trim() !== frontendLatestMatch[1].trim()) {
                    frontendUpdateAvailable = true;
                }
            }
            
            // Update version display with actual current versions
            if (versionDisplayElement && backendCurrentVersion && frontendCurrentVersion) {
                versionDisplayElement.textContent = 
                    'Backend: ' + formatVersionDisplay(backendCurrentVersion) + 
                    ' | Frontend: ' + formatVersionDisplay(frontendCurrentVersion);
            }
            
            // Display appropriate status
            if (backendUpdateAvailable && frontendUpdateAvailable) {
                statusElement.textContent = _('Updates available (Backend + Frontend)');
                statusElement.style.color = '#dc2626';
            } else if (backendUpdateAvailable) {
                statusElement.textContent = _('Backend update available');
                statusElement.style.color = '#dc2626';
            } else if (frontendUpdateAvailable) {
                statusElement.textContent = _('Frontend update available');
                statusElement.style.color = '#dc2626';
            } else if (result.code === 0 || (backendMatch && frontendMatch)) {
                statusElement.textContent = _('Up to date');
                statusElement.style.color = '#059669';
            } else {
                statusElement.textContent = _('Check failed');
                statusElement.style.color = '#dc2626';
            }
        }).catch(function(error) {
            console.error('Error checking for updates:', error);
            statusElement.textContent = _('Check failed');
            statusElement.style.color = '#dc2626';
        }).finally(function() {
            self.versionBusy = null;
        });

        return this.versionBusy;
    }
});
