'use strict';
'require view';
'require uci';
'require ui';
'require rpc';
'require poll';
'require fs';
'require dom';
'require validation';

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
// IPs with an active connection. nobatch: a slow geo lookup never delays the status batch.
// counters: also packets and bytes per server, when the backend counts them (set_counters); an
// older luci.geomate ignores the argument and sends none
var callGeomateConnections = rpc.declare({
    object: 'luci.geomate',
    method: 'getGeomateConnections',
    params: [ 'counters' ],
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

// Known servers of a filter for the map, counted per position. On request only (legend button,
// selected circle), never polled. An older rpcd ACL or luci.geomate rejects it
var callKnownServers = rpc.declare({
    object: 'luci.geomate',
    method: 'getKnownServers',
    params: [ 'sid' ],
    expect: { '': {} },
    reject: true
});

// A getKnownServers answer as the map takes it: { total, approx, decimals, missing, points:
// [[lat, lon, n]] }, or null for an error or an answer of another form, which the map then shows
// as unknown. decimals (how far merged positions were rounded) only when it is 0, 1 or 2: an older
// backend or cache entry has none
function knownServersData(res) {
    var data;

    if (!res || res.error != null || typeof res.total != 'number' || !Array.isArray(res.points))
        return null;
    data = {
        total: res.total,
        approx: res.approx === true,
        missing: res.missing === true,
        points: res.points.filter(function(p) {
            return Array.isArray(p) && p.length == 3 && p.every(Number.isFinite) &&
                Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180 && p[2] > 0;
        })
    };
    if (Number.isInteger(res.decimals) && res.decimals >= 0 && res.decimals <= 2)
        data.decimals = res.decimals;
    return data;
}

// LAN devices for the Source IP suggestions of the filter dialog (same calls as LuCI's Static
// Leases page). The luci-app-geomate ACL grants both; a ubus error such as "Access denied"
// resolves to {}
var callHostHints = rpc.declare({
    object: 'luci-rpc',
    method: 'getHostHints',
    expect: { '': {} }
});

var callNetworkDevices = rpc.declare({
    object: 'luci-rpc',
    method: 'getNetworkDevices',
    expect: { '': {} }
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

// Status of a connection for the table: [ sort key, label, tooltip ]. luci.geomate takes
// 'allowed' from the filter's nft sets: true in _allowed, false in _blocked, missing when the
// server is in neither (untracked); is_allowed_ip: in _allowed and in the filter's own allowed IPs.
// A row the map cannot show gets the tooltip of notOnMapNote, unless it is a past row (offMap): the
// map never shows those. An untracked row has its own tooltip
function connectionStatus(conn, offMap) {
    var note = (offMap || hasPosition(conn.geo)) ? null : notOnMapNote();

    if (conn.is_allowed_ip)
        return [ 'whitelist', _('Whitelisted'), note ];
    if (conn.allowed === true)
        return [ 'allowed', _('Allowed'), note ];
    if (conn.allowed === false)
        return [ 'blocked', _('Blocked'), note ];
    if (conn.allowed == null)
        return [ 'untracked', _('Untracked'), untrackedNote(conn.filter_name) ];
    return [ 'unknown', _('Unknown'), note ];
}

// Whether a connection's geo data has a position the map draws a marker for: finite, non-zero
// lat and lon. The same test as updateConnections in map.html; a failed lookup is an empty array
function hasPosition(geo) {
    var lat, lon;

    if (!geo || typeof geo != 'object' || Array.isArray(geo.lat) || Array.isArray(geo.lon))
        return false;
    lat = Number(geo.lat);
    lon = Number(geo.lon);
    return !!lat && !!lon && isFinite(lat) && isFinite(lon);
}

// Tooltip of a server without a position: it has no map marker until the geo data has one.
// Dynamic and monitor mode collect the server into the IP list and geolocate it later; static
// mode has no collection, so only an uploaded list geolocates it
function notOnMapNote() {
    if ((uci.get('geomate', 'global', 'operational_mode') || 'dynamic') === 'static')
        return _('Not on the map: static mode does not geolocate new servers.');
    return _('Not on the map until geolocated.');
}

// Tooltip of an untracked server of a filter: what the configured mode does with it until it
// is geolocated. Defaults as in geomate.sh and geomate_trigger.sh
function untrackedNote(filterName) {
    var mode = uci.get('geomate', 'global', 'operational_mode') || 'dynamic',
        sec = uci.sections('geomate', 'geo_filter').find(function(s) { return s.name === filterName; }),
        effect, next;

    if (mode === 'monitor')
        effect = _('Monitor mode blocks nothing.');
    else if (uci.get('geomate', 'global', 'strict_mode') === '1')
        effect = _('Strict mode blocks it.');
    else
        effect = _('Not filtered.');

    // Without regions the service start puts no server in a set, geolocated or not. Like the
    // service start, a hand-written 'option allowed_region' counts as no region
    if (sec && !(Array.isArray(sec.allowed_region) && sec.allowed_region.length))
        return _('Filter has no regions.') + ' ' + effect;

    // Static mode collects no new servers, daily geolocation looks them up once a day. Frequent
    // updates run every 30 minutes, every hour while there was nothing to look up
    if (mode === 'static')
        next = _('Static mode does not add it to the IP list.');
    else if (uci.get('geomate', 'global', 'geolocation_mode') === 'daily')
        next = _('Geolocated with the next daily update.');
    else
        next = _('Geolocated with one of the next automatic updates.');

    return _('Not geolocated yet.') + ' ' + effect + ' ' + next;
}

// A table cell as an element: ui.Table puts a plain string in as HTML. Missing values show '–'
function textCell(value, title) {
    var text = (typeof value == 'string' && value !== '') ? value : '–';
    return E('span', (title && title !== text) ? { 'title': title } : {}, [ text ]);
}

// Country cell: the name with the code as tooltip, in narrow cards the code with the name as
// tooltip (.gm-country-code). Without a code the name everywhere. data-value: the name, for
// sorting: ui.Table otherwise takes the text the layout shows
function countryCell(name, code) {
    var cell = textCell(name, code), key = cell.textContent;

    if (typeof code == 'string' && code !== '') {
        cell.className = 'gm-country-name';
        cell = E('span', {}, [ cell, textCell(code, name) ]);
        cell.lastChild.className = 'gm-country-code';
    }
    cell.setAttribute('data-value', key);
    return cell;
}

// A dotted IPv4 address, every octet 0-255 without a leading zero: nft reads 012 as octal
function validIPv4(ip) {
    return /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(ip) && ip.split('.').every(function(o) { return +o <= 255; });
}

// The one geo_filter section with this name. null for none or several: a table action never
// picks the first of two filters with the same name
function sidByName(name) {
    var found = uci.sections('geomate', 'geo_filter').filter(function(s) { return s.name === name; });
    return (found.length === 1) ? found[0]['.name'] : null;
}

// The allowed IPs of a filter as the service reads them: list entries only. A hand-written
// 'option allowed_ip' (a string) allows nothing, like 'option allowed_region' (regionList)
function allowedIpList(sid) {
    var v = uci.get('geomate', sid, 'allowed_ip');
    return Array.isArray(v) ? v : [];
}

// The filter's own allowed IPs list this exact address; a prefix or range around it does not count
function filterAllowsIp(sid, ip) {
    return allowedIpList(sid).indexOf(ip) > -1;
}

// The allowed IPs of a filter split at whitespace and commas, as luci.geomate (allowed_ip_list)
// and the backend read them: the entry '1.2.3.4 5.6.7.8' allows both addresses
function allowedIpTokens(sid) {
    return allowedIpList(sid).reduce(function(tokens, entry) {
        return tokens.concat(String(entry).split(/[\s,]+/).filter(function(t) { return t !== ''; }));
    }, []);
}

// An IPv4 address as a number, null for anything else
function ipNumber(ip) {
    return validIPv4(ip) ? ip.split('.').reduce(function(n, o) { return n * 256 + +o; }, 0) : null;
}

// A prefix (a.b.c.d/nn) or range (a.b.c.d-e.f.g.h) of the filter's allowed IPs covers the
// address. Read like add_element in luci.geomate; other entries count as nothing, also one with
// a leading zero in an octet or the prefix length
function rangeAllowsIp(sid, ip) {
    var n = ipNumber(ip);

    return n != null && allowedIpTokens(sid).some(function(entry) {
        var m = /^([\d.]+)\/(0|[1-9]\d*)$/.exec(entry), lo, hi, size;

        if (m) {
            lo = ipNumber(m[1]);
            if (lo == null || +m[2] > 32)
                return false;
            size = Math.pow(2, 32 - m[2]);
            lo -= lo % size;
            return n >= lo && n < lo + size;
        }
        m = /^([\d.]+)-([\d.]+)$/.exec(entry);
        if (!m)
            return false;
        lo = ipNumber(m[1]);
        hi = ipNumber(m[2]);
        return lo != null && hi != null && n >= lo && n <= hi;
    });
}

// Refusals and errors of a table action: the map toast may be out of view below the table
function notify(text, type) {
    ui.addNotification(null, E('p', {}, [ text ]), type || 'warning');
}

// The status reports this feature token ('capabilities' of getStatus, from
// '/etc/geomate.sh capabilities'). Unknown, as with an older backend or a failed request,
// counts as not supported
function hasCapability(status, token) {
    return !!status && Array.isArray(status.capabilities) && status.capabilities.indexOf(token) > -1;
}

// The backend reloads a configuration change live, so a reload that finds nothing changed
// restarts nothing. Known only from a backend that reports capabilities: all of them came after
// the live reload (geomate PR #15). v1.2.0 restarts on every reload, and so may an unknown one
function reloadsLive(status) {
    return !!status && Array.isArray(status.capabilities) && status.capabilities.length > 0;
}

// Source IP suggestions from luci-rpc getHostHints, labelled like LuCI's Static Leases page:
// 'IP (name)', without a name 'IP (MAC)'. The router's own addresses (getNetworkDevices) and
// 127.0.0.0/8 are left out: a geo filter for them has no use. An address of two hosts counts
// once. Returns { keys: the addresses in numeric order, labels: { address: node }, names:
// { address: host name } }; a label is a node, because LuCI puts a string label in as HTML
// (same function in geofilters.js)
function hostChoices(hints, devices) {
    var own = {}, text = {}, names = {}, labels = {}, keys;

    hints = L.isObject(hints) ? hints : {};
    devices = L.isObject(devices) ? devices : {};

    // getNetworkDevices lists each address as { address, netmask, ... }
    Object.keys(devices).forEach(function(dev) {
        L.toArray(L.isObject(devices[dev]) ? devices[dev].ipaddrs : null).forEach(function(a) {
            if (L.isObject(a) && typeof a.address == 'string')
                own[a.address] = true;
        });
    });

    Object.keys(hints).forEach(function(mac) {
        var h = L.isObject(hints[mac]) ? hints[mac] : {};

        L.toArray(h.ipaddrs || h.ipv4).forEach(function(ip) {
            if (typeof ip != 'string' || !plainIPv4(ip) || /^127\./.test(ip) || own[ip] || text[ip])
                return;
            text[ip] = '%s (%s)'.format(ip, h.name || mac);
            if (h.name)
                names[ip] = h.name;
        });
    });

    keys = L.sortedKeys(text, null, 'addr');
    keys.forEach(function(ip) { labels[ip] = E('span', {}, [ text[ip] ]); });
    return { keys: keys, labels: labels, names: names };
}

// A dotted IPv4 address, every octet 0-255 without a leading zero: nft reads 010 as octal
function plainIPv4(s) {
    return validation.parseIPv4(s) != null && !/(^|\.)0\d/.test(s);
}

// An entry of Source IP as geomate.sh (is_ipv4_entry) takes it: an IPv4 address, a.b.c.d/0-32
// or a range a.b.c.d-e.f.g.h whose first address is not above the last. nft rejects a dotted
// mask (a.b.c.d/255.255.255.0) and a range the other way round
function srcIpEntry(s) {
    var m = /^([\d.]+)(?:\/(3[0-2]|[12]?\d)|-([\d.]+))?$/.exec(s);
    var number = function(ip) {
        return validation.parseIPv4(ip).reduce(function(n, o) { return n * 256 + o; }, 0);
    };

    if (!m || !plainIPv4(m[1]))
        return false;
    if (m[3] == null)
        return true;
    return plainIPv4(m[3]) && number(m[1]) <= number(m[3]);
}

// The entries of a Source IP value (a string, or an array of strings), split at white space.
// A '!' or '!=' written apart from its address joins it: the service reads '!= a.b.c.d' as
// one exception only when it is the whole value (same function in geofilters.js)
function srcIpEntries(value) {
    return L.toArray(L.toArray(value).join(' ').replace(/(^|\s)(!=?)\s+/g, '$1$2'));
}

// Check a Source IP value against the saved one (both as srcIpEntries takes them). multi: the
// backend takes several entries and exceptions ('!' or '!=' before an entry). The unchanged
// saved value is valid, and so is one entry without '!' that it has: a filter saved before
// these checks stays savable. With several entries or an exception the service checks every
// entry and gives any other value to nft unchecked, so every entry must pass, saved ones too.
// Returns true or the error text
function checkSrcIp(value, saved, multi) {
    var entries = srcIpEntries(value), i, entry;

    saved = srcIpEntries(saved);
    if (entries.join(' ') === saved.join(' '))
        return true;
    if (!multi && entries.length > 1)
        return _('This Geomate backend supports one address only.');

    for (i = 0; i < entries.length; i++) {
        entry = entries[i];
        if (entries.length == 1 && entry.charAt(0) != '!' && saved.indexOf(entry) > -1)
            continue;
        if (!multi && entry.charAt(0) == '!')
            return _('This Geomate backend supports no exceptions.');
        if (!srcIpEntry(entry.replace(/^!=?/, '')))
            return _('Expecting: %s').format(_('IPv4 address, address/prefix or address range'));
    }
    return true;
}

// Add the text typed into the input of a Source IP widget as Enter would: the custom input of
// a dropdown loses it when the dropdown closes, and the plain input of a list without
// suggestions keeps it as one unsplit entry. Text that fails the check stays in the input and
// keeps the field invalid; a dropdown opens to show its error (same function in geofilters.js)
function takeTypedEntry(widget) {
    var node = widget ? widget.node : null,
        input = node ? node.querySelector('.create-item-input, .add-item > input.cbi-input-text') : null,
        sb = input ? input.closest('.cbi-dropdown') : null;

    if (!input || !input.value.trim())
        return;
    // LuCI checks the input on keyup; the result also sets the valid state of the field
    input.dispatchEvent(new Event('keyup'));
    if (input.classList.contains('cbi-input-invalid')) {
        // After this click, which closes every dropdown
        if (sb)
            window.setTimeout(function() {
                var ul = sb.querySelector('ul'),
                    reveal = function() {
                        if (sb.hasAttribute('open') && input.classList.contains('cbi-input-invalid')) {
                            input.scrollIntoView({ block: 'nearest' });
                            input.focus();
                        }
                    };

                dom.findClassInstance(sb).openDropdown(sb);
                // openDropdown scrolls the list to the selected item in the next frame, and
                // focuses that item when a theme's transition of the list ends
                window.requestAnimationFrame(reveal);
                ul.addEventListener('transitionend', reveal, { once: true });
            }, 0);
        return;
    }
    if (sb)
        dom.findClassInstance(sb).createItems(sb, input.value);
    else
        widget.addItem(node, input.value, null, true);
    input.value = '';
    widget.triggerValidation();
}

// Make a ui.DynamicList add pasted 'a b' as two entries, like CBIDynamicMultiValueList in
// LuCI's tools/firewall.js (not loaded: luci-app-firewall is no dependency). A single entry
// keeps its label, e.g. a picked suggestion, unless the stored entry reads differently: typed
// '!= a.b.c.d' shows as '!=a.b.c.d' (same function in geofilters.js)
function splitEntries(widget) {
    widget.addItem = function(dl, value, text, flash) {
        var values = srcIpEntries(value);

        values.forEach(function(v) {
            var label = (values.length == 1 && v === String(value).trim()) ? text : (this.choices || {})[v];

            ui.DynamicList.prototype.addItem.call(this, dl, v, dom.elem(label) ? label.cloneNode(true) : label, flash);
        }, this);
    };
    return widget;
}

// Poll intervals in seconds
var CONNECTIONS_INTERVAL = 5,
    STATUS_INTERVAL = 10,
    VERSION_INTERVAL = 3600,
    // Failed getGeomateConnections requests in a row before the status row says the list is old
    CONNECTIONS_STALE_AFTER = 3;

// A server stays in the connections table (column Last seen) for RECENT_WINDOW ms after the last
// reply that had it, under the 1-hour timeout of the _dynamic sets; at most RECENT_MAX servers.
// sessionStorage keeps them for the tab, only as a convenience (readRecent, saveRecent)
var RECENT_WINDOW = 30 * 60 * 1000,
    RECENT_MAX = 300,
    RECENT_SAVE_INTERVAL = 30 * 1000,
    RECENT_STORAGE_KEY = 'geomate-connections-recent';

// Geo fields a connection row shows, the only ones the recent list stores
var GEO_TEXT_FIELDS = [ 'country', 'countryCode', 'city', 'isp', 'org' ];

// The geo text of a connection: string fields only. A failed lookup arrives as an empty array
function geoText(geo) {
    var copy = {};

    if (L.isObject(geo) && !Array.isArray(geo))
        GEO_TEXT_FIELDS.forEach(function(k) {
            if (typeof geo[k] == 'string')
                copy[k] = geo[k];
        });
    return copy;
}

// Key of a server in the recent list
function recentKey(conn) {
    return conn.filter_name + '\0' + conn.dst;
}

// The recent list sessionStorage holds for this tab, as { key: { conn, lastSeen, restored } }.
// Stored are only dst, filter_name, lastSeen and the geo text; an entry of another form is left
// out, a broken value gives an empty list. Of two entries for one address the newer counts. A
// restored entry has no verdict: the table shows it as unknown until a reply has the server again
function readRecent() {
    var list = null, recent = {}, byIp = {};

    try { list = JSON.parse(window.sessionStorage.getItem(RECENT_STORAGE_KEY) || '[]'); } catch (e) {}
    if (!Array.isArray(list))
        return recent;

    list.forEach(function(item) {
        var conn, old;

        if (!L.isObject(item) || typeof item.dst != 'string' || !validIPv4(item.dst) ||
            typeof item.filter_name != 'string' || !FILTER_NAME_RE.test(item.filter_name) ||
            typeof item.lastSeen != 'number' || !isFinite(item.lastSeen) || item.lastSeen <= 0)
            return;
        old = byIp[item.dst];
        if (old && old.lastSeen >= item.lastSeen)
            return;
        if (old)
            delete recent[recentKey(old.conn)];
        conn = { dst: item.dst, filter_name: item.filter_name, geo: geoText(item.geo) };
        recent[recentKey(conn)] = byIp[item.dst] = { conn: conn, lastSeen: item.lastSeen, restored: true };
    });
    return recent;
}

// Status of a row the last reply no longer has (entry e of the recent list), or of a live row while
// the list is old (e.live): the verdict of the last reply that had it, none when restored from
// sessionStorage. An Allow or Remove since then wins: action (connectionAction) comes from the
// configuration, and no reply brings the new verdict
function pastStatus(e, action) {
    var whitelisted = !e.restored && !!e.conn.is_allowed_ip;

    if (action === 'remove' && !whitelisted)
        return [ 'whitelist', _('Whitelisted'), null ];
    if (action === 'allow' && whitelisted && sidByName(e.conn.filter_name))
        return [ 'unknown', _('Unknown'), _('Removed from the allowed IPs since last seen.') ];
    if (e.restored)
        return [ 'unknown', _('Unknown'), _('Seen before the page was loaded.') ];
    return connectionStatus(e.conn, !e.live);
}

// Last seen cell of a row: 'Now' for a server of the last reply (lastSeen null), else the age in
// whole minutes, from 60 minutes on in whole hours, so the text changes at most once a minute.
// Past rows expire after RECENT_WINDOW (pruneRecent); a live row of an old list can be older.
// data-value: the age in seconds, for sorting
function showSeen(node, lastSeen, now) {
    var secs = (lastSeen == null) ? 0 : Math.max(1, Math.floor((now - lastSeen) / 1000)),
        mins = Math.ceil(secs / 60),
        text = (lastSeen == null) ? _('Now') : (mins < 60) ? _('%d min ago').format(mins)
            : _('%d h ago').format(Math.floor(mins / 60));

    if (node.textContent !== text)
        node.textContent = text;
    if (node.getAttribute('data-value') !== String(secs))
        node.setAttribute('data-value', secs);
}

// Columns of the connections table that the code sorts by (sortConnections), by index: LuCI
// stores the sorted column by its index
var COLUMN_IP = 0, COLUMN_COUNTRY = 3, COLUMN_SEEN = 6, COLUMN_TRAFFIC = 7;

// Choices of the "Sort by" select of the card layout: [ column, descending ]. Last seen from the
// newest, traffic from the most packets
var SORT_CHOICES = [ [ COLUMN_SEEN, false ], [ COLUMN_TRAFFIC, true ], [ COLUMN_IP, false ], [ COLUMN_COUNTRY, false ] ];

// The packet rate of a server is taken over the replies of the last RATE_WINDOW ms, once they
// span RATE_MIN_SPAN ms
var RATE_WINDOW = 20 * 1000,
    RATE_MIN_SPAN = 4 * 1000;

// A packet or byte count of luci.geomate: a whole number from 0 on
function isCount(n) {
    return typeof n == 'number' && n >= 0 && Math.floor(n) === n;
}

// Counters of a server in a reply (packets and bytes its filter's _dynamic set counted), with
// those of the previous reply (prev, recordRecent) for the rate: { packets, bytes, samples: [
// [ time, packets ], … ] }. Without prev, or with a smaller count than before (the set was built
// again, as after a service restart), the samples start over. A sample from after now (the
// clock was set back) is dropped. null when the reply has none
function trafficOf(prev, conn, now) {
    var samples = [];

    if (!isCount(conn.packets) || !isCount(conn.bytes))
        return null;
    if (prev && conn.packets >= prev.packets)
        samples = prev.samples.filter(function(s) { return s[0] < now && now - s[0] <= RATE_WINDOW; });
    samples.push([ now, conn.packets ]);
    return { packets: conn.packets, bytes: conn.bytes, samples: samples };
}

// Packets per second of trafficOf() samples, null while they span less than RATE_MIN_SPAN
function trafficRate(t) {
    var first = t.samples[0], last = t.samples[t.samples.length - 1];

    return (last[0] - first[0] >= RATE_MIN_SPAN) ? (last[1] - first[1]) * 1000 / (last[0] - first[0]) : null;
}

// Packets in total for a Traffic cell: exact below 10000, then rounded ('108k packets', '1.2M
// packets'). The table never wraps the Traffic column, so a long session's total would widen
// it; this way the text stays at most 12 characters. The tooltip keeps the exact count
function packetsText(n) {
    if (n < 10000)
        return N_(n, '%d packet', '%d packets').format(n);
    if (n < 999500)
        return _('%dk packets').format(Math.round(n / 1000));
    if (n < 9950000)
        return _('%.1fM packets').format(n / 1000000);
    return _('%dM packets').format(Math.round(n / 1000000));
}

// Traffic cell of a row (rec: its entry of the recent list): the packet rate of a live row, the
// packets in total of a past row and of a live row before its rate is known, '–' without counters
// (older backend, static mode, a row from before the page was loaded). The packets count those
// the devices of the filter sent to the server since its first packet after the last service
// start or after an hour without one. data-value: the packets, for sorting. The tooltip adds the
// bytes, the average packet size and how long this page has seen the server
function showTraffic(node, rec, live) {
    var t = rec && rec.traffic,
        rate = (t && live) ? trafficRate(t) : null,
        secs = (rec && rec.firstSeen) ? Math.round((rec.lastSeen - rec.firstSeen) / 1000) : 0,
        text = '–', title = [];

    // The format follows the rounded rate: 9.96 is '10 pkt/s', not '10.0 pkt/s'
    if (t) {
        if (rate == null)
            text = packetsText(t.packets);
        else if (+rate.toFixed(1) >= 10 || rate == 0)
            text = _('%d pkt/s').format(Math.round(rate));
        else if (+rate.toFixed(2) >= 0.1)
            text = _('%.1f pkt/s').format(rate);
        else
            text = _('%.2f pkt/s').format(rate);

        title.push(N_(t.packets, '%d packet sent to the server, %s', '%d packets sent to the server, %s')
            .format(t.packets, '%1024.1mB'.format(t.bytes)));
        if (t.packets > 0)
            title.push(_('%d bytes per packet').format(Math.round(t.bytes / t.packets)));
        if (secs > 0)
            title.push(_('Seen for %s while this page was open').format('%t'.format(secs)));
    }

    if (node.textContent !== text)
        node.textContent = text;
    node.classList.toggle('gm-traffic--none', !t);
    node.classList.toggle('gm-traffic--past', !live);
    node.setAttribute('data-value', t ? t.packets : 0);
    if (title.length)
        node.setAttribute('title', title.join('\n'));
    else
        node.removeAttribute('title');
}

// The texts of a connection the search looks in: IP, filter, country with its code (what narrow
// cards show), city and ISP, lowercase
function searchText(conn) {
    var geo = geoText(conn.geo);

    return [ conn.dst, conn.filter_name, geo.country, geo.countryCode, geo.city, geo.isp ].filter(function(s) {
        return typeof s == 'string';
    }).join('\n').toLowerCase();
}

// check_version asks the GitHub API, which allows 60 unauthenticated requests per hour and public
// IP. The browser keeps the last result ({ stdout, stderr, code, at, ui, installed }) and shows it
// again on page load and in the hourly poll: a success for VERSION_INTERVAL, a failure for
// VERSION_RETRY seconds, and only for the installed versions it was asked for (installedKey): an
// update of either component makes it stale
var VERSION_CACHE_KEY = 'geomate-version-check',
    VERSION_RETRY = 600;

// Fields of status.installed (getStatus): the version markers of the installed files, which
// check_version reports as 'Current version'
var INSTALLED_FIELDS = [ 'backend', 'backend_channel', 'frontend', 'frontend_channel' ];

// Symbols of the health check states in the status row
var CHECK_ICONS = { ok: '✓', info: '○', warning: '⚠', error: '✗' };

// Operational modes in the order of the mode menu, the values of the Geo Filters page
var MODE_ORDER = [ 'dynamic', 'static', 'monitor' ];

// After a mode change, the status row waits this long (ms) for the restart (modeChanged)
var RESTART_WAIT = 60 * 1000;

// procd runs geomate's reload trigger this long (ms) after a commit (PROCD_RELOAD_DELAY in
// /lib/functions/procd.sh); commits within that time share one reload
var PROCD_RELOAD_DELAY = 1000;

// [ name, description ] per operational mode, for the status row and its mode menu
function modeTexts() {
    return {
        monitor: [ _('Monitor mode'), _('Connections are tracked but not blocked.') ],
        static: [ _('Static mode'), _('Uses the IP lists as they are.') ],
        dynamic: [ _('Dynamic mode'), _('Builds IP lists automatically.') ]
    };
}

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

// A version marker as the updater stamps it: 'dev', a release such as 1.2.0 or a commit hash
function validVersion(v) {
    return typeof v == 'string' && (v === 'dev' || /^\d+\.\d+\.\d+$/.test(v) || /^[0-9a-f]{7,40}$/.test(v));
}

// The installed versions of a getStatus reply as one string, null when the reply has none (no
// reply, or an rpcd backend without the field)
function installedKey(st) {
    var inst = st && st.installed,
        values = !L.isObject(inst) ? [] : INSTALLED_FIELDS.map(function(k) {
            return (typeof inst[k] == 'string') ? inst[k] : '';
        });

    return values.some(function(v) { return v !== ''; }) ? JSON.stringify(values) : null;
}

// The cached check_version result while it is fresh, else null. A success expires a minute early,
// so the hourly poll asks again. With the installed versions known on both sides (installed: the
// installedKey of the status) they decide, so after an update the entry is stale, and a page
// reloaded after a frontend update uses the entry the old page stored for it. Else only the
// frontend version of this page counts, as before
function cachedVersionCheck(installed) {
    var entry = null, ttl;

    try { entry = JSON.parse(window.localStorage.getItem(VERSION_CACHE_KEY) || 'null'); } catch (e) {}
    if (!entry || typeof entry.stdout != 'string' || typeof entry.at != 'number')
        return null;
    if ((installed != null && typeof entry.installed == 'string') ? entry.installed !== installed : entry.ui !== UI_VERSION)
        return null;
    ttl = (versionState(entry).state == 'failed') ? VERSION_RETRY : VERSION_INTERVAL - 60;
    return (Date.now() >= entry.at && Date.now() - entry.at < ttl * 1000) ? entry : null;
}

function storeVersionCheck(entry) {
    try { window.localStorage.setItem(VERSION_CACHE_KEY, JSON.stringify(entry)); } catch (e) {}
}

// Click handler of the reload link in the status row. LuCI loads a view by the URL below
// (base_url, ?v=<LuCI version>) and allows the browser cache, and uhttpd sends no Cache-Control,
// so a plain reload may run the old view.js again: fetch both views past the cache first
function reloadViews(ev) {
    var v = L.env.resource_version ? '?v=' + L.env.resource_version : '';

    ev.preventDefault();
    Promise.all([ 'view', 'geofilters' ].map(function(name) {
        return window.fetch(L.env.base_url + '/view/geomate/' + name + '.js' + v, { cache: 'reload' }).catch(function() {});
    })).then(function() {
        window.location.reload();
    });
}

return view.extend({
    // Every map change is applied at once (commitGeomate), so the page has no footer
    handleSave: null,
    handleSaveApply: null,
    handleReset: null,

    knownChanges: '[]', // staged geomate changes at the last check, as JSON (stagedKey)
    notice: null,       // notification about staged geomate changes (showNotice)
    noticeText: null,   // its text paragraph
    stagedNotice: null, // its text while an action that is not a map change runs (enqueue)
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
    versionInstalled: null, // installed versions (installedKey) for which a check was last started
    connectionsTable: null, // ui.Table of the active connections
    connectionsActions: false,  // the table has the Allow/Remove column (write access at render)
    connectionsKey: null,   // rows of the last table update, as JSON
    recent: null,           // servers of recent replies: { 'filter\0ip': { conn, lastSeen, restored, firstSeen, traffic } }
    recentSaved: null,      // recent list as last written to sessionStorage, as JSON
    recentSavedAt: 0,       // time of the last write
    seenCells: [],          // Last seen and Traffic cells of the table: [{ node, lastSeen, traffic }], updated in place
    connectionsQuery: '',   // text of the search field, lowercase
    withCounters: false,    // the backend counts packets per server (set_counters), as the last status reply said
    configLoads: 0,     // configuration reloads running (whileReloading); the table waits for them
    themeKey: null,         // last theme sent to the map, as JSON
    fullscreen: false,      // the map covers the window
    hostsLoad: null,        // promise of the Source IP suggestions (loadHostChoices)
    serversLoads: {},       // running getKnownServers request per filter section
    restartPid: null,       // PID of the service when a mode change was applied, until it restarted
    restartAt: 0,           // time of that change

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
        this.recent = readRecent();

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
            #geomate-status, #gm-mode-menu, #active-connections-container {
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
            /* With write access the mode pill is the button of the mode menu: the pill's look,
               none of the theme's button styles. Argon's dark mode sets every button's border
               with !important; the ID selectors win once these are important too */
            #geomate-status button.gm-status {
                -webkit-appearance: none;
                appearance: none;
                width: auto;
                height: auto;
                min-width: 0;
                min-height: 0;
                margin: 0;
                padding: 0 0.6em;
                font: inherit;
                line-height: 1.6;
                letter-spacing: inherit;
                text-transform: none;
                text-shadow: none;
                color: inherit;
                background: none;
                border: 1px solid var(--gm-status-color) !important;
                border-radius: 999px;
                box-shadow: none;
                cursor: pointer;
            }
            #geomate-status button.gm-status:focus { outline: none; }
            #geomate-status button.gm-status:focus-visible { outline: 2px solid var(--gm-primary); outline-offset: 2px; }
            /* The menu lies outside the <summary>, where a click would open or close the details.
               Its colors come from detectTheme() when it opens, like the map's Draw circle menu */
            .gm-status-box { position: relative; }
            #gm-mode-menu { position: absolute; z-index: 100; box-sizing: border-box; width: max-content; min-width: 12em; max-width: min(24em, 100%); padding: 4px 0; color: var(--gm-menu-fg, inherit); background: var(--gm-menu-bg, #fff); border: 1px solid var(--gm-menu-border, rgba(0, 0, 0, 0.2)); border-radius: 4px; box-shadow: 0 1px 5px rgba(0, 0, 0, 0.4); }
            #gm-mode-menu[hidden] { display: none; }
            #gm-mode-menu button {
                -webkit-appearance: none;
                appearance: none;
                display: flex;
                gap: 8px;
                box-sizing: border-box;
                width: 100%;
                height: auto;
                min-height: 0;
                margin: 0;
                padding: 6px 12px;
                font: inherit;
                line-height: 1.4;
                letter-spacing: inherit;
                text-align: left;
                text-transform: none;
                text-shadow: none;
                white-space: normal;
                color: inherit;
                background: none;
                border: 0 !important;
                border-radius: 0;
                box-shadow: none;
                cursor: pointer;
            }
            #gm-mode-menu button:hover, #gm-mode-menu button:focus { background: var(--gm-menu-hover, rgba(128, 128, 128, 0.15)); outline: none; }
            #gm-mode-menu button:focus-visible { outline: 2px solid var(--gm-primary); outline-offset: -2px; }
            #gm-mode-menu .gm-mode-check { flex: none; width: 1em; color: var(--gm-primary); visibility: hidden; }
            #gm-mode-menu [aria-checked="true"] .gm-mode-check { visibility: visible; }
            #gm-mode-menu .gm-mode-note { display: block; font-size: 90%; opacity: 0.7; }
        `);

        // A key and its value in the details panel
        var row = function(label, value) {
            return [ E('span', { 'class': 'gm-muted' }, [ label ]), value ];
        };

        n.state = E('span', { 'id': 'service-status-text', 'class': 'gm-status gm-status--neutral gm-muted' });
        // updateStatus() sets the mode name in modeLabel
        n.modeLabel = E('span');
        n.mode = this.readonly ? this.renderModeLabel() : this.renderModeMenu();
        n.health = E('span', { 'id': 'health-check-status' });
        n.loading = E('span', { 'id': 'geomate-loading-indicator', 'class': 'gm-note' }, [ _('Loading GeoFilter data ...') ]);
        n.stale = E('span', { 'id': 'geomate-connections-stale', 'class': 'gm-note' });
        n.reload = E('span', { 'id': 'geomate-reload-note', 'class': 'gm-note', 'hidden': '' }, [
            _('The web interface was updated.'), ' ',
            E('a', { 'href': '#', 'click': reloadViews }, [ _('Reload the page') ])
        ]);
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
                n.state, n.mode, n.health, n.loading, n.stale, n.reload,
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

        n.statusBox = E('div', { 'class': 'gm-status-box' }, [ style, n.statusRow ].concat(n.modeMenu ? [ n.modeMenu ] : []));
        return n.statusBox;
    },

    /**
     * Mode button and mode menu of the status row (write access only): the mode pill opens a
     * menu of the three modes with their descriptions, the running one checked. Like the map's
     * Draw circle menu it opens on a click, Enter, Space or an arrow key, the arrow keys, Home and
     * End move between the entries, and it closes on Escape and Tab (the focus goes back to the
     * button), a press outside it, the focus leaving it and a pick (switchMode).
     * @returns {Node} The button; the menu is this.nodes.modeMenu.
     */
    renderModeMenu: function() {
        var self = this, n = this.nodes, texts = modeTexts(), spaceDown = false;

        n.modeMenu = E('div', {
            'id': 'gm-mode-menu',
            'role': 'menu',
            'aria-label': _('Mode'),
            'hidden': '',
            // A press on the menu keeps the focus where it is
            'mousedown': noFocus,
            'keydown': L.bind(this.handleModeMenuKey, this),
            'focusout': function(ev) {
                if (!n.modeMenu.contains(ev.relatedTarget) && ev.relatedTarget !== n.mode)
                    self.closeModeMenu(false);
            }
        }, MODE_ORDER.map(function(mode) {
            return E('button', {
                'type': 'button',
                'role': 'menuitemradio',
                'tabindex': '-1',
                'aria-checked': 'false',
                'data-mode': mode,
                'click': function() {
                    self.closeModeMenu(true);
                    // The running mode: nothing to do
                    if (mode !== self.statusMode())
                        self.switchMode(mode);
                }
            }, [
                E('span', { 'class': 'gm-mode-check', 'aria-hidden': 'true' }, [ '✓' ]),
                E('span', {}, [
                    E('span', { 'class': 'gm-mode-name' }, [ texts[mode][0] ]),
                    E('span', { 'class': 'gm-mode-note' }, [ texts[mode][1] ])
                ])
            ]);
        }));

        document.addEventListener('pointerdown', function(ev) {
            if (!n.modeMenu.hidden && !n.modeMenu.contains(ev.target) && !n.mode.contains(ev.target))
                self.closeModeMenu(false);
        }, true);
        window.addEventListener('resize', function() {
            if (!n.modeMenu.hidden)
                self.placeModeMenu();
        });

        return E('button', {
            'type': 'button',
            'id': 'operational-mode-text',
            'class': 'gm-status gm-status--mode',
            'aria-haspopup': 'menu',
            'aria-expanded': 'false',
            'aria-controls': 'gm-mode-menu',
            'click': function(ev) {
                // The button is inside the <summary>: no toggle of the details
                ev.preventDefault();
                if (n.modeMenu.hidden)
                    self.openModeMenu(false);
                else
                    self.closeModeMenu(false);
            },
            'keydown': function(ev) {
                if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp')
                    return;
                // No click and no toggle of the details either
                ev.preventDefault();
                ev.stopPropagation();
                // Space opens on keyup, like the Draw circle button: otherwise the keyup
                // reaches the entry that got the focus (Firefox would pick it)
                if (ev.key === ' ')
                    spaceDown = true;
                else
                    self.openModeMenu(ev.key === 'ArrowUp');
            },
            'keyup': function(ev) {
                if (ev.key !== ' ' || !spaceDown)
                    return;
                ev.preventDefault();
                ev.stopPropagation();
                spaceDown = false;
                self.openModeMenu(false);
            },
            'blur': function() { spaceDown = false; }
        }, [ n.modeLabel, ' ', E('span', { 'aria-hidden': 'true' }, [ '▾' ]) ]);
    },

    // The plain mode pill of a read-only page (no menu)
    renderModeLabel: function() {
        return E('span', { 'id': 'operational-mode-text', 'class': 'gm-status gm-status--mode' }, [ this.nodes.modeLabel ]);
    },

    // The page turned read-only after render (resync): the mode button becomes the plain pill
    lockModeMenu: function() {
        var n = this.nodes, button = n && n.modeMenu && n.mode, label;

        if (!button || button.tagName !== 'BUTTON')
            return;
        this.closeModeMenu(false);
        label = this.renderModeLabel();
        label.hidden = button.hidden;
        label.title = button.title;
        button.parentNode.replaceChild(label, button);
        n.mode = label;
    },

    // The mode the status reports: the committed configuration's, the one the service runs with
    // once it has (re)started. null without a status. An unknown value counts as dynamic, like
    // in the status row
    statusMode: function() {
        var mode = this.status && this.status.operational_mode;
        return mode ? (MODE_ORDER.indexOf(mode) > -1 ? mode : 'dynamic') : null;
    },

    modeItems: function() {
        return Array.prototype.slice.call(this.nodes.modeMenu.querySelectorAll('[role="menuitemradio"]'));
    },

    // Check the entry of the status's mode
    markModeMenu: function() {
        var mode = this.statusMode();

        this.modeItems().forEach(function(item) {
            item.setAttribute('aria-checked', (item.getAttribute('data-mode') === mode) ? 'true' : 'false');
        });
    },

    /**
     * Shows the mode menu below the mode button, in the theme's colors, and focuses the checked
     * entry (last: the last entry, for ArrowUp).
     * @param {boolean} last - Focus the last entry.
     */
    openModeMenu: function(last) {
        var n = this.nodes, theme, fg, items, item;

        if (this.readonly || !n.modeMenu || n.mode.hidden)
            return;

        theme = this.detectTheme();
        fg = parseRgb(theme.fg);
        n.modeMenu.style.setProperty('--gm-menu-bg', theme.bg);
        n.modeMenu.style.setProperty('--gm-menu-fg', theme.fg);
        n.modeMenu.style.setProperty('--gm-menu-border', theme.border);
        if (fg)
            n.modeMenu.style.setProperty('--gm-menu-hover', rgbString(fg, 0.12));

        this.markModeMenu();
        n.modeMenu.hidden = false;
        n.mode.setAttribute('aria-expanded', 'true');
        this.placeModeMenu();

        items = this.modeItems();
        item = last ? items[items.length - 1]
            : (items.filter(function(i) { return i.getAttribute('aria-checked') === 'true'; })[0] || items[0]);
        item.focus({ preventScroll: true });
    },

    /**
     * Hides the mode menu.
     * @param {boolean} focusButton - Give the focus back to the mode button (Escape, Tab, a pick).
     */
    closeModeMenu: function(focusButton) {
        var n = this.nodes;

        if (!n || !n.modeMenu || n.modeMenu.hidden)
            return;
        n.modeMenu.hidden = true;
        n.mode.setAttribute('aria-expanded', 'false');
        if (focusButton)
            n.mode.focus({ preventScroll: true });
    },

    // Below the mode button, inside the status box: on a narrow page moved left to fit
    placeModeMenu: function() {
        var n = this.nodes, box, b;

        n.modeMenu.style.left = n.modeMenu.style.top = '0px';
        box = n.statusBox.getBoundingClientRect();
        b = n.mode.getBoundingClientRect();
        n.modeMenu.style.left = Math.max(0, Math.min(b.left - box.left, box.width - n.modeMenu.offsetWidth)) + 'px';
        n.modeMenu.style.top = (b.bottom - box.top + 4) + 'px';
    },

    handleModeMenuKey: function(ev) {
        var items = this.modeItems(), i = items.indexOf(document.activeElement), next = null;

        if (ev.key === 'ArrowDown')
            next = items[(i + 1) % items.length];
        else if (ev.key === 'ArrowUp')
            next = items[(i > 0) ? i - 1 : items.length - 1];
        else if (ev.key === 'Home')
            next = items[0];
        else if (ev.key === 'End')
            next = items[items.length - 1];
        else if (ev.key === 'Tab')
            // Tab goes on from the button
            return this.closeModeMenu(true);
        else if (ev.key !== 'Escape')
            return;
        ev.preventDefault();
        ev.stopPropagation();
        if (next)
            next.focus();
        else
            this.closeModeMenu(true);
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
        var look = function() {
            self.sendTheme(false);
            self.updateStickyHeader();
        };
        var update = function() {
            look();
            window.clearTimeout(timer);
            timer = window.setTimeout(look, 400);
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

        // Cards: each server is a card of two lines, IP, status and button above, filter, country,
        // ISP and last seen below; no city, no column titles, none of the theme's cell labels. The
        // placeholder row (one cell) keeps the theme's look
        var cards = `
                #geomate-connections { display: block; }
                #geomate-connections .tr:not(.placeholder) { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; margin: 0; padding: 6px 4px; border: 0; border-bottom: 1px solid rgba(128, 128, 128, 0.25); }
                /* After the row rule, which has the same weight */
                #geomate-connections .tr.table-titles { display: none; }
                /* OpenWrt2020 positions the placeholder cell in its row, and above its own stacking
                   width that row is a table row, which shrinks to a narrow column in a block table */
                #geomate-connections .tr.placeholder { display: block; }
                /* Zero-height item that breaks the card into its two lines */
                #geomate-connections .tr:not(.placeholder)::before { content: ""; order: 4; flex: 0 0 100%; height: 0; margin: 0; padding: 0; border: 0; }
                #geomate-connections .tr:not(.placeholder) > .td { display: block; flex: none; align-self: auto; width: auto; max-width: none; margin: 0; padding: 0; border: 0; overflow: visible; text-align: left; white-space: nowrap; }
                #geomate-connections .tr:not(.placeholder) > .td::before { content: none; }
                #geomate-connections .tr:not(.placeholder) > .gm-col-ip { order: 1; flex: 1 1 auto; font-weight: bold; }
                #geomate-connections .tr:not(.placeholder) > .gm-col-status { order: 2; }
                #geomate-connections .tr:not(.placeholder) > .gm-col-action { order: 3; }
                #geomate-connections .tr:not(.placeholder) > .gm-col-city { display: none; }
                /* Second line, small and dimmed. A long name ends in "…" instead of wrapping the
                   line: filter and country have a maximum width, the ISP fills the rest with at least
                   15%. The three add up to 70%, so last seen stays on the line */
                #geomate-connections .tr:not(.placeholder) > .gm-col-filter,
                #geomate-connections .tr:not(.placeholder) > .gm-col-country,
                #geomate-connections .tr:not(.placeholder) > .gm-col-isp { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: max(85%, 11px); opacity: 0.75; }
                #geomate-connections .tr:not(.placeholder) > .gm-col-filter { order: 5; flex: 0 1 auto; max-width: 30%; }
                #geomate-connections .tr:not(.placeholder) > .gm-col-country { order: 6; flex: 0 1 auto; max-width: 25%; }
                #geomate-connections .tr:not(.placeholder) > .gm-col-isp { order: 7; flex: 1 1 0; min-width: 15%; }
                /* A row with traffic makes room for it: filter and country get narrower, the ISP
                   gets only what is left. Browsers without :has() (Firefox before 121) keep the
                   wider names, and the line may wrap */
                #geomate-connections .tr:has(.gm-traffic:not(.gm-traffic--none)) > .gm-col-filter { max-width: 25%; }
                #geomate-connections .tr:has(.gm-traffic:not(.gm-traffic--none)) > .gm-col-country { max-width: 18%; }
                #geomate-connections .tr:has(.gm-traffic:not(.gm-traffic--none)) > .gm-col-isp { min-width: 0; }
                /* "Filter · Country · ISP" and "Last seen · Traffic": the dot starts the next cell,
                   so a cut name keeps it. Traffic has it in its text, which is hidden without
                   counters: no "· –" */
                #geomate-connections .tr:not(.placeholder) > .gm-col-country::before,
                #geomate-connections .tr:not(.placeholder) > .gm-col-isp::before,
                #geomate-connections .tr:not(.placeholder) .gm-traffic::before { content: "·"; display: inline; position: static; width: auto; margin: 0 8px 0 0; padding: 0; border: 0; background: none; font-weight: inherit; }
                #geomate-connections .tr:not(.placeholder) .gm-traffic--none { display: none; }
                /* Not dimmed: past rows dim the text themselves (.gm-seen--past, .gm-traffic--past) */
                #geomate-connections .tr:not(.placeholder) > .gm-col-seen { order: 8; margin-left: auto; font-size: max(85%, 11px); }
                #geomate-connections .tr:not(.placeholder) > .gm-col-traffic { order: 9; font-size: max(85%, 11px); }
                /* The empty cell would still add a gap */
                #geomate-connections .tr:not(.placeholder) > .gm-col-traffic:has(.gm-traffic--none) { display: none; }
                /* The column titles are hidden: the select sorts like them */
                #active-connections-container .gm-connections-sort { display: flex; }
        `;

        // Narrow cards show the country code instead of the name (countryCell), so the ISP keeps
        // its room next to last seen and traffic
        var codes = `
                #geomate-connections .gm-country-name { display: none; }
                #geomate-connections .gm-country-code { display: inline; }
        `;

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
            /* Search field and, in the card layout, the "Sort by" select above the table. The bar
               is a container of the same name and width as the table's box (below), so the card
               query shows the select exactly when the table shows cards. Its items keep a margin
               for the theme's focus ring: the container clips at its edges */
            #active-connections-container .gm-connections-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 0 8px; margin-top: 6px; container: gm-connections / inline-size; overflow: hidden; scrollbar-gutter: stable; }
            #active-connections-container .gm-connections-tools > * { margin: 3px; }
            #active-connections-container .gm-connections-search { flex: 1 1 12em; width: auto; min-width: 0; max-width: 24em; }
            #active-connections-container .gm-connections-sort { display: none; flex: none; align-items: center; gap: 6px; white-space: nowrap; }
            #active-connections-container .gm-connections-sort select { width: auto; min-width: 0; margin: 0; }
            /* Argon and Material set overflow-y: hidden on .table, which would make the table the
               scroll box of the sticky title cells below and let them scroll away with the rows */
            #active-connections-container .table { margin: 0; overflow: visible; }
            /* The column titles stay visible while the table scrolls: sticky cells, a sticky row
               is unreliable. Opaque fill in the theme's color: updateStickyHeader() */
            #active-connections-container .table-titles > .th,
            #active-connections-container thead th { position: sticky; top: 0; z-index: 1; }
            #active-connections-container .gm-sticky-fill .table-titles > .th,
            #active-connections-container .gm-sticky-fill thead th { background-color: var(--gm-sticky-bg); }
            /* Pills and theme colors: renderStatus */
            .gm-status--allowed { --gm-status-color: var(--gm-success); }
            .gm-status--blocked { --gm-status-color: var(--gm-danger); }
            .gm-status--whitelist { --gm-status-color: var(--gm-primary); }
            .gm-status--untracked, .gm-status--unknown { --gm-status-color: #8c959f; }
            #active-connections-container .gm-seen, #active-connections-container .gm-traffic { white-space: nowrap; }
            #active-connections-container .gm-seen--past, #active-connections-container .gm-traffic--past { opacity: 0.65; }
            #geomate-connections .gm-country-code { display: none; }
            /* Compact rows: less cell padding than the themes give a table, a small button and pill.
               Text never below 11px: Material's tables are 11.2px below 1367 px */
            #geomate-connections .td, #geomate-connections .th { padding: 5px 10px; vertical-align: middle; }
            #geomate-connections .td .cbi-button { padding: 1px 10px; line-height: 1.5; height: auto; min-height: 0; font-size: max(90%, 11px); }
            #geomate-connections .gm-status { line-height: 1.4; }
            /* OpenWrt2020 fades a stacked cell at 40% of its width (up to 800 px), where its own
               padding started the text; with the compact padding the fade would cover the text */
            #geomate-connections .td::after { content: none; }
            /* The room of the table picks the layout, not the window: the themes stack the rows of
               every table below a window width of their own (OpenWrt2020 800 px, OpenWrt.org 992 px,
               Argon and Material 1152 px, Bootstrap on devices up to 600 px), however wide the table
               is. Up to 960 px cards, below 560 px with the country code. Wider: a table, also where
               the theme stacks, up to 1040 px without the city as in the cards. From there a row
               with traffic fits without scrolling in every theme: OpenWrt2020, with 16 px text,
               needs the most room (about 890 px without the city, 1000 px with it; packetsText
               keeps totals short).
               The gutter keeps the room of a vertical scrollbar, whether the box scrolls or not:
               the query then measures the width the table gets, however many rows there are */
            #active-connections-container .gm-connections-wrap { container: gm-connections / inline-size; scrollbar-gutter: stable; }
            /* Table: rows, cells and column titles back to table display, none of the theme's cell
               labels. IP, status, last seen, traffic and button never wrap; filter, country, city
               and ISP may. Text alignment stays the theme's, except the column titles where
               Material aligns its stacked cells left (up to 1152 px) */
            @container gm-connections (width > 960px) {
                #geomate-connections { display: table; width: 100%; }
                #geomate-connections .tr { display: table-row; }
                #geomate-connections .tr > .th, #geomate-connections .tr > .td { display: table-cell; }
                #geomate-connections .td::before { content: none; display: none; }
                #geomate-connections .gm-col-ip, #geomate-connections .gm-col-status,
                #geomate-connections .gm-col-seen, #geomate-connections .gm-col-traffic,
                #geomate-connections .gm-col-action { white-space: nowrap; }
                @media (max-width: 1152px) {
                    #geomate-connections .tr > .th { text-align: left; }
                }
            }
            @container gm-connections (960px < width <= 1040px) {
                #geomate-connections .tr > .gm-col-city { display: none; }
            }
            @container gm-connections (width <= 960px) {${cards}}
            @container gm-connections (width < 560px) {${codes}}
            /* Browsers without container queries: cards with the code up to a 600 px window, the
               theme's layout above */
            @supports not (container-type: inline-size) {
                @media (max-width: 600px) {${cards}${codes}}
            }
        `);

        // Sortable columns; the theme styles the table like every LuCI table. With write access a
        // last column without a title holds Allow/Remove, like the action column of LuCI tables.
        // Last seen and Traffic come after the earlier columns: LuCI stores the sorted column by its
        // index (COLUMN_*). A class per column for the card layout and the table's wrapping; LuCI
        // also gives the first one to the placeholder
        var captions = [ _('IP'), _('Filter'), _('Status'), _('Country'), _('City'), _('ISP'), _('Last seen'), _('Traffic') ],
            columns = [ 'ip', 'filter', 'status', 'country', 'city', 'isp', 'seen', 'traffic' ],
            options = {
                id: 'geomate-connections',
                sortable: true,
                placeholder: _('No active connections'),
                captionClasses: columns.map(function(c) { return 'gm-col-' + c; })
            };

        this.connectionsActions = !this.readonly;
        if (this.connectionsActions) {
            captions.push('');
            options.sortable = captions.map(function(c, i) { return i < captions.length - 1; });
            options.captionClasses.push([ 'cbi-section-actions', 'gm-col-action' ]);
        }
        this.connectionsTable = new ui.Table(captions, options, E('em', {}, [ _('Loading connections…') ]));
        // A click on a column title sorts in ui.Table's handler on the title row, before this one
        this.connectionsTable.render().addEventListener('click', L.bind(this.showSortChoice, this));

        // The search keeps its text over the polls; the select sorts like the column titles
        n.connectionsSearch = E('input', {
            'type': 'text',
            'class': 'cbi-input-text gm-connections-search',
            'placeholder': _('Search'),
            'aria-label': _('Search'),
            'input': L.bind(function(ev) {
                this.connectionsQuery = ev.target.value.trim().toLowerCase();
                this.updateActiveConnectionsList();
            }, this)
        });
        n.connectionsSort = E('select', {
            'class': 'cbi-input-select',
            'change': L.bind(function(ev) { this.sortConnections(+ev.target.value); }, this)
        }, SORT_CHOICES.map(function(c) {
            return E('option', { 'value': c[0] }, [ captions[c[0]] ]);
        }));
        this.showSortChoice();

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
            E('div', { 'class': 'gm-connections-tools' }, [
                n.connectionsSearch,
                E('label', { 'class': 'gm-connections-sort' }, [ _('Sort by'), n.connectionsSort ])
            ]),
            n.connectionsWrap = E('div', { 'class': 'gm-connections-wrap', 'id': 'gm-connections-wrap' }, [ this.connectionsTable.render() ])
        ]);

        return n.connections;
    },

    // Sort the connections by a column of SORT_CHOICES (the "Sort by" select), as a click on its
    // column title would: ui.Table keeps the order for the page
    sortConnections: function(column) {
        var table = this.connectionsTable,
            choice = SORT_CHOICES.find(function(c) { return c[0] === column; });

        if (!choice)
            return;
        table.setActiveSortState(choice[0], choice[1]);
        table.update(table.data, table.placeholder);
    },

    // Show the choice the table is sorted by in the "Sort by" select: its column in its direction.
    // Empty for any other order, such as a column title clicked the other way: picking a choice
    // then always sorts. Unsorted, the table lists the servers by last seen
    showSortChoice: function() {
        var select = this.nodes.connectionsSort,
            state = this.connectionsTable.getActiveSortState() || [ COLUMN_SEEN, false ];

        if (select)
            select.value = SORT_CHOICES.some(function(c) { return c[0] === state[0] && c[1] === !!state[1]; }) ? String(state[0]) : '';
    },

    // Fill of the sticky column titles: the first opaque background from a title cell up. Argon
    // paints the cells, Bootstrap the title row, other themes only the section or the page; a
    // transparent sticky cell would show the scrolled rows through it. Called when the table is
    // shown and when the theme changes
    updateStickyHeader: function() {
        var wrap = this.nodes && this.nodes.connectionsWrap,
            cell = wrap && wrap.querySelector('.table-titles > .th, thead th'),
            el, c = null;

        if (!cell || !cell.isConnected)
            return;
        // Read the theme's colors, not the last fill
        wrap.classList.remove('gm-sticky-fill');
        for (el = cell; el && !c; el = el.parentElement) {
            c = parseRgb(window.getComputedStyle(el).backgroundColor);
            if (c && c.a < 1)
                c = null;
        }
        // Without any background the browser paints the page white
        wrap.style.setProperty('--gm-sticky-bg', c ? rgbString(c) : THEME_FALLBACKS.light.bg);
        wrap.classList.add('gm-sticky-fill');
    },

    // After the connections section opened or closed: the map gets smaller while the table is shown
    toggleConnections: function() {
        var n = this.nodes,
            show = n.connections.open;

        n.connectionsToggle.textContent = show ? _('Hide') : _('Show');
        n.frame.classList.toggle('gm-map-frame--short', show);
        if (show) {
            this.updateStickyHeader();
            n.connections.scrollIntoView({ behavior: 'smooth' });
        }
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
            loading, problems = (st && !running && st.config_enabled !== false) ? [ 'process' ] : [];

        if (!n)
            return;

        // After a mode change the status reports the new mode before procd has restarted the
        // service (modeChanged). Until a reply shows the restart (another PID, the loading file,
        // the service stopped) the loading note shows, so the mode never looks applied early
        if (this.restartPid != null && st && (!running || st.pid !== this.restartPid || st.loading || Date.now() - this.restartAt > RESTART_WAIT))
            this.restartPid = null;
        loading = !!(st ? (st.loading || this.restartPid != null) : (this.health && this.health.loading));

        var state = st ? (running ? _('Running') : _('Not running'))
            : (this.statusLoaded ? _('Status unknown') : _('Loading status...'));
        n.state.textContent = state;
        n.state.className = 'gm-status ' + (st ? (running ? 'gm-status--running' : 'gm-status--stopped') : 'gm-status--neutral gm-muted');
        n.state.title = pid ? _('PID %d').format(pid) : '';
        n.detailService.textContent = pid ? _('Running (PID %d)').format(pid) : state;
        n.loading.hidden = !loading;

        // Operational mode of the committed configuration, the one the service runs with
        var mode = this.statusMode() ? modeTexts()[this.statusMode()] : null;
        n.mode.hidden = !mode;
        n.modeLabel.textContent = mode ? mode[0] : '';
        n.mode.title = mode ? mode[1] : '';
        n.detailMode.textContent = mode ? mode[1] : '–';
        if (!mode)
            this.closeModeMenu(false);
        else if (n.modeMenu)
            this.markModeMenu();

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

    // The installed view.js (status.installed, from rpcd) is another version than this page: an
    // update replaced it after the page was loaded, or the browser runs a cached copy. The
    // unstamped 'dev' (a clone served by a dev proxy) is compared with nothing
    pageOutdated: function() {
        var inst = this.status && this.status.installed,
            installed = L.isObject(inst) ? inst.frontend : null;

        return validVersion(installed) && validVersion(UI_VERSION) && installed !== 'dev' &&
            UI_VERSION !== 'dev' && installed !== UI_VERSION;
    },

    // Show the versions and the update state of versionInfo; before the first result the
    // frontend version of this file. On an outdated page (pageOutdated) the reload note shows,
    // and a frontend update is not offered: check_version compares the installed frontend
    showVersions: function() {
        var n = this.nodes,
            v = this.versionInfo || versionState({}),
            outdated = this.pageOutdated(),
            update = (outdated && v.update == 'both') ? 'backend' : (outdated && v.update == 'frontend') ? null : v.update,
            versions = [],
            summary = '', detail = '', primary = false;

        if (!n)
            return;

        n.reload.hidden = !outdated;

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
            // Outdated page with only a frontend update: the reload note says it
            if (update) {
                summary = (update == 'both') ? _('Update available')
                    : (update == 'backend') ? _('Backend update available') : _('Frontend update available');
                detail = (update == 'both') ? _('Backend and frontend updates available') : summary;
                primary = true;
            }
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
        window.addEventListener('pagehide', L.bind(this.saveRecent, this, true));
    },

    // No connection requests while the tab is hidden
    handleVisibilityChange: function() {
        if (document.hidden) {
            poll.remove(this.pollFns.connections);
            this.saveRecent(true);
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
                // A failed request keeps the last answer, so the counters do not start over
                if (r[0])
                    self.withCounters = hasCapability(r[0], 'set_counters');
                self.statusLoaded = true;
                self.updateStatus(true);
                self.showVersions();
                self.checkAfterUpdate();
            }).finally(function() {
                self.statusBusy = null;
            });

        return this.statusBusy;
    },

    // One request at a time: a direct call while the poll's request runs shares it. Counters only
    // once a status reply said the backend has them: the first request of the page goes without
    pollConnections: function() {
        var self = this;

        if (!this.connectionsBusy)
            this.connectionsBusy = L.resolveDefault(callGeomateConnections(this.withCounters), null).then(function(list) {
                var failed = self.connectionsFailed, last = self.connectionsAt;

                self.connectionsFailed = list ? 0 : failed + 1;
                if (list)
                    self.connectionsAt = Date.now();
                if (self.connectionsFailed >= CONNECTIONS_STALE_AFTER || failed >= CONNECTIONS_STALE_AFTER)
                    self.updateStatus();
                if (!list) {
                    // Without any reply the table would keep saying it loads
                    if (self.connectionsAt == null && self.connectionsFailed == CONNECTIONS_STALE_AFTER && self.connectionsTable) {
                        self.connectionsTable.update([], _('Connections unavailable'));
                        self.connectionsKey = null;
                    }
                    // Past rows keep aging and expire; an old list shows its age (Last seen)
                    if (self.connectionsAt != null)
                        self.updateActiveConnectionsList();
                    return;
                }
                // The counters go on from the last reply only when no request failed since
                self.showConnections(list, self.connectionsAt, failed ? null : last);
            }).finally(function() {
                self.connectionsBusy = null;
            });

        return this.connectionsBusy;
    },

    // A getGeomateConnections reply that arrived at now: the live rows of the table and the
    // markers of the map, which gets only these. Every server in it counts as seen now
    // (recordRecent); prevAt: as there
    showConnections: function(list, now, prevAt) {
        this.connections = list;
        this.recordRecent(list, now, prevAt);
        this.saveRecent(false);
        this.sendMessageToMap('updateConnections', list);
        this.updateActiveConnectionsList();
    },

    // Note the servers of a reply as seen at now, with their counters (trafficOf) and the time this
    // page first saw them. One row per server, as in the reply: a server that another filter has
    // now drops its entry of the earlier filter, whose counters were another set's. The counters
    // go on only for a server of the previous reply, which arrived at prevAt (null: none, or a
    // request failed since). A server it lacked may count from 0 again: every service restart
    // builds the sets again, and _ui_dynamic drops a server after 10 s without a packet
    recordRecent: function(list, now, prevAt) {
        var recent = this.recent, live = {};

        list.forEach(function(conn) {
            if (conn && conn.filter_name && typeof conn.dst == 'string')
                live[conn.dst] = conn;
        });
        Object.keys(recent).forEach(function(key) {
            var conn = live[recent[key].conn.dst];

            if (conn && recentKey(conn) !== key)
                delete recent[key];
        });
        Object.keys(live).forEach(function(ip) {
            var key = recentKey(live[ip]), old = recent[key];

            recent[key] = {
                conn: live[ip],
                lastSeen: now,
                firstSeen: (old && old.firstSeen) || now,
                traffic: trafficOf((old && old.lastSeen === prevAt) ? old.traffic : null, live[ip], now)
            };
        });
        this.pruneRecent(now);
    },

    // Drop the servers last seen more than RECENT_WINDOW ago, then the oldest beyond RECENT_MAX.
    // A time after now (the clock was set back) counts as now
    pruneRecent: function(now) {
        var recent = this.recent, keys;

        Object.keys(recent).forEach(function(key) {
            if (recent[key].lastSeen > now)
                recent[key].lastSeen = now;
            else if (now - recent[key].lastSeen > RECENT_WINDOW)
                delete recent[key];
        });
        keys = Object.keys(recent);
        if (keys.length > RECENT_MAX)
            keys.sort(function(a, b) { return recent[b].lastSeen - recent[a].lastSeen; })
                .slice(RECENT_MAX).forEach(function(key) { delete recent[key]; });
    },

    // Keep the recent list in sessionStorage for this tab (readRecent): at most every
    // RECENT_SAVE_INTERVAL, and whenever the page is hidden or left (force). Only a convenience:
    // a failed write changes nothing on the page
    saveRecent: function(force) {
        var now = Date.now(), recent = this.recent, text;

        if (!recent || (force !== true && Math.abs(now - this.recentSavedAt) < RECENT_SAVE_INTERVAL))
            return;
        this.recentSavedAt = now;
        text = JSON.stringify(Object.keys(recent).map(function(key) {
            var e = recent[key];
            return { dst: e.conn.dst, filter_name: e.conn.filter_name, lastSeen: e.lastSeen, geo: geoText(e.conn.geo) };
        }));
        if (text === this.recentSaved)
            return;
        try {
            window.sessionStorage.setItem(RECENT_STORAGE_KEY, text);
            this.recentSaved = text;
        } catch (e) {}
    },

    // Ask for the connections again after a table action: a request already running may have
    // been answered before the commit
    refreshConnections: function() {
        var self = this;

        return Promise.resolve(this.connectionsBusy).then(function() {
            return self.pollConnections();
        });
    },

    // Ask for the status again after a mode change, like refreshConnections()
    refreshStatus: function() {
        var self = this;

        return Promise.resolve(this.statusBusy).then(function() {
            return self.pollStatus();
        });
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
        case 'loadKnownServers':
            this.loadKnownServers(String(d.sid || ''));
            break;
        }
    },

    // Known servers of a filter for the map (message knownServers). Read only, also without
    // write access. An error reaches the map as 'error', which it shows as unknown, never as
    // 0 servers; the notification comes once per filter and page, and 'notified' tells the map
    // not to add its own note for the same failure
    loadKnownServers: function(sid) {
        var self = this, loads = this.serversLoads;

        if (!isGeoFilter(sid))
            return this.sendMessageToMap('knownServers', { sid: sid, error: true });
        if (!loads[sid])
            loads[sid] = callKnownServers(sid).then(function(res) {
                var data = knownServersData(res), err;

                if (!data) {
                    err = new Error((res && typeof res.error == 'string') ? res.error : _('Unexpected answer'));
                    err.answered = !!(res && res.error != null);
                    throw err;
                }
                self.sendMessageToMap('knownServers', Object.assign(data, { sid: sid }));
            }).catch(function(err) {
                // luci.geomate reads the committed configuration only: a filter added on the Geo
                // Filters page and not applied yet is unknown to it and has no known servers yet
                return (err && err.answered ? callUciChanges().then(function(changes) {
                    return L.toArray(changes.geomate).some(function(c) {
                        return c[0] == 'add' && c[1] == sid;
                    });
                }).catch(function() {
                    return false;
                }) : Promise.resolve(false)).then(function(staged) {
                    var text;

                    if (staged)
                        return self.sendMessageToMap('knownServers', { sid: sid, total: 0, approx: false, missing: true, points: [] });
                    // -32002 Access denied: the session's ACL has no getKnownServers, e.g. a login
                    // from before an update of the web interface
                    text = /\berror -32002\b/.test(errorText(err))
                        ? _('Could not load the known servers of %s. Log in again after an update of the web interface.').format(self.filterName(sid))
                        : _('Could not load the known servers of %s: %s').format(self.filterName(sid), errorText(err));
                    self.sendMessageToMap('knownServers', { sid: sid, error: true, notified: self.warnOnce(sid + ' servers', text) });
                });
            }).finally(function() {
                delete loads[sid];
            });
        return loads[sid];
    },

    // Run map actions one after another, each on the configuration as committed now (another
    // tab may have applied changes since): uci.save() reloads it, so a second action must not
    // read it in between. checkStaged() may stop an action before it changes anything; its
    // circle then goes back (token), or onRefuse(reason, ok) answers. An action with a circle queued
    // before the map got all filters again (pushFilters) is dropped: the map no longer has its
    // circle. So is an action whose filter id sid names another filter now than at the click
    // (movedFilter; a resync queued before may have renamed the id in sidNames since). A failed
    // action shows the error, and the map shows the configuration again (resync). report(text):
    // shows the error instead of the map toast (table actions). notice: the text of the notice
    // about unsaved changes while this action runs (showNotice), the map's by default
    enqueue: function(token, sid, fn, onRefuse, report, notice) {
        var self = this, generation = this.generation, known = this.sidNames[sid];

        this.busy = Promise.resolve(this.busy).then(function() {
            var loaded;

            if (self.readonly)
                return token && self.sendMessageToMap('regionRejected', { token: token, reason: '' });
            if (token && generation !== self.generation)
                return self.sendMessageToMap('toast', { text: _('Not applied: the map was reloaded.') });
            self.stagedNotice = notice || null;
            // Both reads in one request (LuCI sends the calls of one frame together), so e.g. the
            // dialog of a mode switch comes one round trip sooner. A refused action has loaded the
            // configuration as the session holds it, staged changes included, like a page load
            loaded = self.loadConfig().then(function() { return null; }, function(err) { return err || new Error(); });
            return Promise.all([ self.checkStaged(), loaded ]).then(function(r) {
                var ok = r[0], reason = (ok === null) ? _('Could not check for unsaved changes.')
                    : _('Apply or revert the unsaved geomate changes first.');

                if (r[1])
                    throw r[1];
                if (!ok) {
                    if (token)
                        return self.sendMessageToMap('regionRejected', { token: token, reason: reason });
                    return onRefuse ? onRefuse(reason, ok) : self.sendMessageToMap('toast', { text: reason });
                }
                if (self.movedFilter(sid, known))
                    throw filtersChanged();
                return fn();
            });
        }).catch(function(err) {
            return self.resync((err && err.plain) ? err.message
                : _('Could not apply the change: %s').format(errorText(err)), token, report);
        }).finally(function() {
            self.stagedNotice = null;
        });
        return this.busy;
    },

    // Drop the in-memory configuration and load it as the session holds it now: at the start of
    // each map action, again after a dialog, which may have stayed open while another tab
    // applied changes, and in resync
    loadConfig: function() {
        return this.whileReloading(function() {
            uci.unload('geomate');
            return uci.load('geomate');
        });
    },

    // Run fn, which unloads the configuration and loads it again (loadConfig, uci.save()). Until
    // it is back, a connections poll would see no filters and show every row with Allow
    whileReloading: function(fn) {
        var self = this;

        this.configLoads++;
        return Promise.resolve().then(fn).finally(function() {
            self.configLoads--;
        });
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
            return self.whileReloading(function() { return uci.save(); });
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

    // One notification about staged geomate changes, with a button to LuCI's changes dialog. It
    // names what waits for them: the map, or the action that runs (stagedNotice of enqueue); a
    // notice that shows already takes the new text
    showNotice: function() {
        var n = this.notice,
            text = this.stagedNotice || _('Apply or revert the unsaved geomate changes before you change the map.');

        if (n && n.parentNode && !n.classList.contains('fade-out')) {
            this.noticeText.textContent = text;
            return;
        }
        this.noticeText = E('p', {}, [ text ]);
        this.notice = ui.addNotification(null, [
            this.noticeText,
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
    // circles and loses its tools, so nothing is applied on top of a missing one. report(text):
    // shows the error instead of the map toast (enqueue)
    resync: function(reason, token, report) {
        var self = this,
            tell = report || function(text) { self.sendMessageToMap('toast', { text: text }); };

        return L.resolveDefault(this.loadConfig(), null).then(function(loaded) {
            if (!loaded) {
                self.readonly = true;
                self.lockModeMenu();
                self.sendMessageToMap('setReadonly', { readonly: true });
                if (token)
                    self.sendMessageToMap('regionRejected', { token: token, reason: '' });
                self.updateActiveConnectionsList();
                return tell(reason + ' ' + _('Reload the page.'));
            }
            return self.refreshChanges().then(function() {
                self.pushFilters();
                self.updateActiveConnectionsList();
                tell(reason);
            });
        });
    },

    /**
     * 'Applied.' in the map with Undo, which restores the options the change set. Only the last
     * change can be undone. Call it after applyChange(): after is the reloaded filter.
     * @param {string} sid - The filter section; 'global' for a mode switch.
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
                keys = u.before ? changedOptions(u.after || {}, u.before) : null,
                // The one change of the global section: a mode switch (switchMode)
                mode = u.sid === 'global';

            // A change queued before the click has been applied since: Undo would revert it too
            if (self.undoSeq !== u.id)
                return self.sendMessageToMap('toast', { text: _('Only the last change can be undone.') });
            // Clicked twice: undone already
            if (self.undo !== u)
                return;
            self.undo = null;
            if (!now || !u.after)
                throw failure(mode ? _('Not undone: the mode has changed since.') : _('Filter %s not found.').format(name));
            if (keys ? changedOptions(pick(now, keys), pick(u.after, keys)).length : changedOptions(now, u.after).length)
                return self.sendMessageToMap('toast', { text: mode ? _('Not undone: the mode has changed since.')
                    : _('Not undone: filter %s has changed since.').format(name) });

            if (!u.before)
                uci.remove('geomate', u.sid);
            else
                keys.forEach(function(k) {
                    uci.set('geomate', u.sid, k, (u.before[k] != null) ? u.before[k] : null);
                });

            return self.applyChange(function() {
                var after = filterOptions(u.sid);
                if (u.before ? (!after || changedOptions(pick(after, keys), pick(u.before, keys)).length) : after)
                    throw failure(mode ? _('Could not undo the mode change.') : _('Could not undo the change of filter %s.').format(name));
            }).then(function() {
                // The map's filters have not changed with the mode
                if (!mode)
                    self.pushFilters();
                // Undo of Allow or Remove: the table shows the other button again
                self.updateActiveConnectionsList();
                self.refreshConnections();
                if (mode)
                    self.modeChanged(true);
                self.sendMessageToMap('toast', { text: _('Undone.') });
            });
        }, function(reason) {
            self.sendToast(reason, u);
        }, null, (u.sid === 'global') ? _('Apply or revert the unsaved geomate changes before you change the mode.') : null);
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
    // the user may act on it only later, when drawing a region for that filter. Returns true
    // when it showed the warning now
    warnOnce: function(key, text) {
        if (this.reported[key])
            return false;
        this.reported[key] = true;
        ui.addNotification(null, E('p', {}, [ text ]), 'warning');
        return true;
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

    // Source IP suggestions (hostChoices), fetched when the filter dialog opens for the first
    // time, then kept for the page. Not in load(): LuCI sends the calls of load() as one batch,
    // which would delay the map
    loadHostChoices: function() {
        if (!this.hostsLoad)
            this.hostsLoad = Promise.all([
                L.resolveDefault(callHostHints(), {}),
                L.resolveDefault(callNetworkDevices(), {})
            ]).then(function(r) {
                return hostChoices(r[0], r[1]);
            });
        return this.hostsLoad;
    },

    // The filter dialog, after its Source IP suggestions and the backend's capabilities have
    // arrived. Without a status poll result yet the status is asked once
    openFilterModal: function(token, region, pick) {
        var self = this;

        return Promise.all([
            this.loadHostChoices(),
            this.status || L.resolveDefault(callGetStatus(), null)
        ]).then(function(r) {
            return self.renderFilterModal(token, region, pick, r[0], hasCapability(r[1], 'src_ip_multi'));
        });
    },

    // A new circle was drawn for a new filter: name it, or choose a filter. The circle stays
    // pending on the map until this modal ends with regionSaved, regionDiscarded or regionRejected.
    // pick: NEW_FILTER opens with the name field focused, '' with the filter list. hosts: the
    // Source IP suggestions (hostChoices); multi: the backend takes several Source IP entries
    renderFilterModal: function(token, region, pick, hosts, multi) {
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

        var ipPlaceholder = _('1.2.3.4 or 1.2.3.0/24'),
            portPlaceholder = _('25200 25300 or 27015-27020');

        // Entries of the shown filter's saved Source IP, valid as they are (checkSrcIp). The
        // widget's own check passes '', the input of the widget the typed text. No datatype:
        // ui checks it before validate, and a saved value it rejects would block the dialog
        var srcSaved = [];
        var srcValidate = function(v) {
            return checkSrcIp((v == null || v === '') ? fields.src_ip.getValue() : v, srcSaved, multi);
        };
        var srcHint = E('div', { 'class': 'cbi-value-description' }, [
            (multi ? _('Devices this filter applies to. Empty: all devices. Put ! before an address to leave it out.')
                : _('Device this filter applies to. Empty: all devices.')) + ' ' +
            _('Use a static lease so the address stays the same.')
        ]);

        var fields = {
            enabled: new ui.Checkbox('1', { value_enabled: '1', value_disabled: '0' }),
            protocol: new ui.Select('udp', { tcp: 'TCP', udp: 'UDP' }, {}),
            // Like the field on the Geo Filters page: a list with a backend that reports
            // src_ip_multi, else one address; a text field without suggestions
            src_ip: multi
                ? splitEntries(new ui.DynamicList([], hosts.keys.length ? hosts.labels : null,
                    { sort: hosts.keys, placeholder: _('-- add IP --'), validate: srcValidate }))
                : hosts.keys.length
                    ? new ui.Combobox('', hosts.labels, { sort: hosts.keys, select_placeholder: _('any'), validate: srcValidate })
                    : new ui.Textfield('', { placeholder: _('any'), validate: srcValidate }),
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
            // Source IP is one option, its entries separated by a space; never a UCI list
            if (k == 'src_ip')
                return srcIpEntries(v).join(' ');
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
            // An option or a hand-written list
            srcSaved = sec ? srcIpEntries(sec.src_ip) : [];

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
                // The entries for the list, one string for the combobox; null clears it
                else if (k == 'src_ip')
                    v = multi ? srcSaved.slice() : (srcSaved.join(' ') || null);
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
            body.appendChild(row(labels[k], fields[k].render(), (k == 'src_ip') ? [ srcHint ] : (k != 'ip_list') ? null : [
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

                // Source IP text typed without Enter counts too
                takeTypedEntry(fields.src_ip);
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

    // Fill the connections table: the servers of the last reply ('Now'), then those of the
    // recent list that it no longer has, newest first; with text in the search field only those
    // whose IP, filter, country, city or ISP contain it. Country, city and ISP come from
    // luci.geomate's geo lookup; older backends and cache entries have none of them, the cells
    // then show '–'. A past row keeps the verdict of the last reply that had it (pastStatus);
    // restored from sessionStorage it has none. The button of a row comes from the configuration
    // (connectionAction). The table is rebuilt only when a row changed: ui.Table replaces every
    // row, and with it a button under the pointer. The Last seen and Traffic cells change in
    // place; sorted by traffic, the table is rebuilt when the order of the packets changes.
    // Until the first reply the table keeps saying it loads, or that the list is unavailable
    updateActiveConnectionsList: function() {
        var self = this, table = this.connectionsTable, recent = this.recent, now = Date.now();
        if (!table || !this.nodes.connectionsTitle || this.configLoads || this.connectionsAt == null) return;

        // Skip any connection object lacking filter_name to avoid errors
        var list = this.connections.filter(function(conn) {
            return conn && conn.filter_name;
        });

        this.nodes.connectionsTitle.textContent = _('Active connections (%d)').format(list.length);

        // Past rows of a filter that is gone or disabled are dropped; without a loaded
        // configuration nothing tells, and they stay
        var live = {}, filters = null, past;

        list.forEach(function(conn) { live[conn.dst] = true; });
        if (uci.sections('geomate').length) {
            filters = {};
            uci.sections('geomate', 'geo_filter').forEach(function(s) {
                if (s.enabled === '1')
                    filters[s.name] = true;
            });
        }
        this.pruneRecent(now);
        past = Object.keys(recent).filter(function(key) {
            if (filters && !filters[recent[key].conn.filter_name]) {
                delete recent[key];
                return false;
            }
            return !live[recent[key].conn.dst];
        }).map(function(key) { return recent[key]; }).sort(function(a, b) { return b.lastSeen - a.lastSeen; });

        // While the status row says the list is old, its rows show the age of the last reply and,
        // like past rows, an Allow or Remove since then (pastStatus). rec: the entry of the recent
        // list, with the counters
        var liveSeen = (this.connectionsFailed >= CONNECTIONS_STALE_AFTER) ? this.connectionsAt : null;
        var all = list.map(function(conn) {
            return { conn: conn, lastSeen: liveSeen, live: true, rec: recent[recentKey(conn)] };
        }).concat(past.map(function(e) { return Object.assign({ rec: e }, e); }));
        var query = this.connectionsQuery;
        var entries = query ? all.filter(function(e) { return searchText(e.conn).indexOf(query) > -1; }) : all;
        var rows = entries.map(function(e) {
            var conn = e.conn,
                action = self.connectionAction(conn),
                // A failed lookup arrives as an empty array
                geo = (conn.geo && typeof conn.geo == 'object' && !Array.isArray(conn.geo)) ? conn.geo : {};

            return {
                ip: conn.dst,
                filter: conn.filter_name,
                status: (e.live && liveSeen == null) ? connectionStatus(conn) : pastStatus(e, action),
                geo: [ geo.country, geo.countryCode, geo.city, geo.isp, geo.org ],
                action: action,
                past: e.lastSeen != null
            };
        });
        var placeholder = (all.length && !entries.length) ? _('No matching connections') : null;
        var sorting = table.getActiveSortState();
        var key = JSON.stringify([ rows, placeholder ]);

        // The order ui.Table gives the rows: descending negates the comparison, equal packets
        // keep the order of the rows (stable sort)
        if (sorting && sorting[0] === COLUMN_TRAFFIC)
            key += JSON.stringify(entries.map(function(e, i) { return i; }).sort(function(a, b) {
                var ta = entries[a].rec && entries[a].rec.traffic, tb = entries[b].rec && entries[b].rec.traffic;
                return (sorting[1] ? -1 : 1) * ((ta ? ta.packets : 0) - (tb ? tb.packets : 0)) || (a - b);
            }));

        if (key === this.connectionsKey) {
            this.seenCells.forEach(function(c, i) {
                c.lastSeen = entries[i].lastSeen;
                showSeen(c.node, c.lastSeen, now);
                showTraffic(c.traffic, entries[i].rec, !rows[i].past);
            });
            return;
        }
        this.connectionsKey = key;
        this.seenCells = [];

        table.update(rows.map(function(r, i) {
            var status = r.status,
                attrs = { 'class': 'gm-status gm-status--' + status[0], 'data-value': status[0] },
                seen = {
                    node: E('span', { 'class': r.past ? 'gm-seen gm-seen--past' : 'gm-seen' }),
                    lastSeen: entries[i].lastSeen,
                    traffic: E('span', { 'class': 'gm-traffic' })
                },
                cells;

            if (status[2])
                attrs.title = status[2];
            showSeen(seen.node, seen.lastSeen, now);
            showTraffic(seen.traffic, entries[i].rec, !r.past);
            self.seenCells.push(seen);

            // Every cell is an element: names and provider strings never run as markup
            cells = [
                textCell(r.ip),
                textCell(r.filter),
                E('span', attrs, [ status[1] ]),
                countryCell(r.geo[0], r.geo[1]),
                textCell(r.geo[2]),
                textCell(r.geo[3], r.geo[4]),
                seen.node,
                seen.traffic
            ];
            if (self.connectionsActions)
                cells.push(self.renderConnectionAction(r));
            return cells;
        }), placeholder);
        this.showSortChoice();
    },

    // Button of a table row, from the configuration as loaded: 'remove' when the filter's own
    // allowed IPs list the address as an entry of its own, 'entry' (no button) when a longer
    // entry such as '1.2.3.4 5.6.7.8' lists it, 'range' (no button) when only a prefix or range
    // of them covers it, else 'allow'. null without write access. Not from the poll's
    // is_allowed_ip: right after an action that is still the old verdict. A filter name that is
    // not unique gets 'allow', and the click says why nothing happens (setIpAllowed)
    connectionAction: function(conn) {
        var sid;

        if (!this.connectionsActions || this.readonly || !validIPv4(conn.dst))
            return null;
        sid = sidByName(conn.filter_name);
        if (sid && filterAllowsIp(sid, conn.dst))
            return 'remove';
        if (sid && allowedIpTokens(sid).indexOf(conn.dst) > -1)
            return 'entry';
        return (sid && rangeAllowsIp(sid, conn.dst)) ? 'range' : 'allow';
    },

    renderConnectionAction: function(r) {
        if (r.action === 'entry')
            return textCell('', _('Part of a longer allowed IP entry. Edit it on the Geo Filters page.'));
        if (r.action === 'range')
            return textCell('', _('In an allowed IP range. Edit it on the Geo Filters page.'));
        if (r.action !== 'allow' && r.action !== 'remove')
            return '';

        var allow = r.action === 'allow';

        return E('button', {
            'class': 'btn cbi-button ' + (allow ? 'cbi-button-positive' : 'cbi-button-negative'),
            'title': (allow ? _('Add %s to the allowed IPs of %s') : _('Remove %s from the allowed IPs of %s')).format(r.ip, r.filter),
            'click': ui.createHandlerFn(this, 'setIpAllowed', r.filter, r.ip, allow)
        }, [ allow ? _('Allow') : _('Remove') ]);
    },

    /**
     * Add a server IP to the allowed IPs of a filter or remove it (table button), and apply that
     * like a map change: 'Applied.' with Undo in the map toast. Refusals show as notifications.
     * Without B1 (backend) the commit restarts geomate instead of reloading the filter's sets.
     * @param {string} name - The filter name of the row.
     * @param {string} ip - The server address of the row.
     * @param {boolean} allow - true: add the address, false: remove it.
     */
    setIpAllowed: function(name, ip, allow) {
        var self = this;

        if (!validIPv4(ip)) {
            notify(_('Invalid IP address %s.').format(ip));
            return Promise.resolve();
        }

        return this.enqueue(null, null, function() {
            // The configuration was loaded again: look the filter up once more
            var sid = sidByName(name), before, list;

            if (!sid)
                return notify(uci.sections('geomate', 'geo_filter').some(function(s) { return s.name === name; })
                    ? _('Not applied: several filters are named %s.').format(name)
                    : _('Filter %s not found.').format(name));

            // The service ignores a hand-written option; never turn it into a list here
            if (typeof uci.get('geomate', sid, 'allowed_ip') == 'string')
                return notify(_('Filter %s has "option allowed_ip". Edit it on the Geo Filters page.').format(name));

            // Changed in another tab since the table showed the button
            if (filterAllowsIp(sid, ip) === allow) {
                notify((allow ? _('%s is already in the allowed IPs of %s.') : _('%s is not in the allowed IPs of %s.')).format(ip, name), 'info');
                return self.updateActiveConnectionsList();
            }

            before = filterOptions(sid);
            list = allowedIpList(sid).filter(function(entry) { return entry !== ip; });
            if (allow)
                list.push(ip);
            uci.set('geomate', sid, 'allowed_ip', list.length ? list : null);

            // As in checkRegion: commit only when the reloaded configuration holds the change
            return self.applyChange(function() {
                if (uci.get('geomate', sid, 'name') !== name || filterAllowsIp(sid, ip) !== allow)
                    throw failure(_('Could not save the allowed IPs of filter %s.').format(name));
            }).then(function() {
                var text = (allow ? _('Added %s to the allowed IPs of %s.') : _('Removed %s from the allowed IPs of %s.')).format(ip, name);

                self.updateActiveConnectionsList();
                self.refreshConnections();
                self.showApplied(sid, before, text);
                // The toast needs the map; without it the notification is the only feedback
                if (!self.mapReady)
                    notify(text, 'info');
            });
        }, L.bind(this.notifyRefused, this), notify);
    },

    // onRefuse of an action outside the map (enqueue): the refusal as a notification, unless
    // checkStaged() refused it (ok false) and its notice about unsaved changes shows
    notifyRefused: function(reason, ok) {
        if (ok !== false || !(this.notice && this.notice.parentNode))
            notify(reason);
    },

    /**
     * Switch the operational mode (mode menu of the status row) and apply it like a map change:
     * a toast with Undo. A switch from monitor mode, after which geomate blocks, asks first.
     * procd's reload trigger restarts geomate with the new mode; a disabled service stays
     * stopped. Refusals and errors show as notifications.
     * @param {string} mode - 'dynamic', 'static' or 'monitor'.
     */
    switchMode: function(mode) {
        var self = this;

        if (MODE_ORDER.indexOf(mode) < 0)
            return Promise.resolve();

        var configured = function() {
            return uci.get('geomate', 'global', 'operational_mode') || 'dynamic';
        };

        return this.enqueue(null, null, function() {
            // Applied in the meantime, e.g. in another tab: the status row catches up
            if (configured() === mode)
                return self.refreshStatus();

            return ((configured() === 'monitor') ? self.confirmMode(mode).then(function(ok) {
                return ok && self.loadConfig().then(function() { return ok; });
            }) : Promise.resolve(true)).then(function(ok) {
                var before = filterOptions('global'), text;

                if (!ok)
                    return;
                if (configured() === mode)
                    return self.refreshStatus();
                if (!before)
                    throw failure(_('Could not save the mode.'));

                uci.set('geomate', 'global', 'operational_mode', mode);
                // As in checkRegion: commit only when the reloaded configuration holds the change
                return self.applyChange(function() {
                    if (configured() !== mode)
                        throw failure(_('Could not save the mode.'));
                }).then(function() {
                    // Enabled but not running: the reload may start it (a run loop procd gave
                    // up on) or not (service stopped), so the text makes no claim
                    text = self.serviceUp() ? _('Switched to %s. Geomate restarts.').format(modeTexts()[mode][0])
                        : (self.status && self.status.config_enabled === false) ? _('Saved. Geomate is not running.')
                        : _('Switched to %s.').format(modeTexts()[mode][0]);
                    self.showApplied('global', before, text);
                    // The toast needs the map; without it the notification is the only feedback
                    if (!self.mapReady)
                        notify(text, 'info');
                    self.modeChanged();
                });
            });
        }, L.bind(this.notifyRefused, this), notify, _('Apply or revert the unsaved geomate changes before you change the mode.'));
    },

    // Resolves true when the user confirms a switch from monitor mode to mode, which then blocks.
    // Cancel and Escape put the focus back on the mode button; LuCI leaves it on the page
    confirmMode: function(mode) {
        var n = this.nodes,
            strict = uci.get('geomate', 'global', 'strict_mode') === '1',
            title = (mode === 'static') ? _('Switch to Static mode?') : _('Switch to Dynamic mode?'),
            label = (mode === 'static') ? _('Switch to Static mode') : _('Switch to Dynamic mode');

        return new Promise(function(resolve) {
            var button = function(cls, text, ok) {
                return E('button', { 'class': 'btn ' + cls, 'click': function() {
                    ui.hideModal();
                    if (!ok && n.mode)
                        n.mode.focus();
                    resolve(ok);
                } }, [ text ]);
            };
            // Cancel first: Escape clicks the first button of the dialog
            var confirm = button('cbi-button-action', label, true);

            ui.showModal(title, [
                E('p', {}, [ _('Geomate will block servers outside your regions.') ]),
                strict ? E('p', {}, [ _('Strict mode also blocks servers that are not geolocated yet.') ]) : '',
                E('div', { 'class': 'right' }, [ button('', _('Cancel'), false), ' ', confirm ])
            ]);
            confirm.focus();
        });
    },

    // The status reports the service running and enabled: a mode change restarts it
    serviceUp: function() {
        var st = this.status;
        return !!(st && st.running && st.config_enabled !== false);
    },

    // After a mode change was committed: until a status reply shows that procd restarted the
    // service, the status row shows it as loading (updateStatus). The PID to wait for comes from
    // a reply fetched after the commit: this.status may be up to STATUS_INTERVAL old, from before
    // an earlier restart. A reply later than procd's reload delay may already show the restarted
    // service, so its PID counts only when it is the one from before the commit. An Undo within
    // that delay shares the switch's reload. A backend that reloads live (reloadsLive) then finds
    // the configuration unchanged and restarts nothing: no wait. Any other backend may restart, so
    // the wait stays, at most RESTART_WAIT. The connection tooltips depend on the configured mode
    modeChanged: function(undo) {
        var self = this, at = Date.now(),
            merged = undo && this.restartPid != null && at - this.restartAt < PROCD_RELOAD_DELAY &&
                reloadsLive(this.status),
            before = (!merged && this.serviceUp()) ? this.status.pid : null;

        // Until the reply, the loading note shows from the PID known before
        this.restartPid = before;
        this.restartAt = at;
        this.updateStatus();
        this.updateActiveConnectionsList();
        return this.refreshStatus().then(function() {
            var st = self.status;

            // No restart to wait for, or a later mode change has taken over
            if (merged || self.restartAt !== at)
                return;
            self.restartPid = (self.serviceUp() && !st.loading && (Date.now() - at < PROCD_RELOAD_DELAY || st.pid === before))
                ? st.pid : null;
            self.updateStatus();
        });
    },

    // After an update of either component the status reports other installed versions: ask for
    // the versions again, once per change. A plain restart changes nothing here. A result cached
    // for these versions (e.g. by another tab) is shown without a request (checkForUpdates), and
    // any result stays while the status has no installed versions. A check that fails without a
    // result is not repeated by the status poll, the hourly poll tries again. A busy check is no
    // reason to wait: it ends here (checkForUpdates) and finds versions that changed meanwhile
    checkAfterUpdate: function() {
        var installed = installedKey(this.status);

        if (installed == null || installed === this.versionInstalled || this.versionBusy)
            return;
        this.versionInstalled = installed;
        this.checkForUpdates();
    },

    /**
     * Check for updates, one call at a time. On page load and in the hourly poll a fresh cached
     * result (cachedVersionCheck) is shown instead of asking GitHub again.
     * @param {boolean} force - Ask GitHub now, whatever the cache holds ('Check again').
     */
    checkForUpdates: function(force) {
        var self = this, installed = null,
            cached = (force === true) ? null : cachedVersionCheck(installedKey(this.status));

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
            // A status request on its way tells which installed versions this check belongs to
            return Promise.resolve(self.statusBusy).catch(function() {});
        }).then(function() {
            installed = installedKey(self.status);
            self.versionInstalled = installed;
            // With the installed versions known now, an entry stored for them may count after all
            // (e.g. by the page before a reload)
            var known = (force === true) ? null : cachedVersionCheck(installed);
            if (known)
                return known;
            // -i: past the backend's own 10-minute cache of the GitHub answer as well
            return fs.exec('/etc/init.d/geomate', (force === true) ? [ 'check_version', '-i' ] : [ 'check_version' ]).then(function(result) {
                var entry = { stdout: result.stdout || '', stderr: result.stderr || '', code: result.code, at: Date.now(), ui: UI_VERSION, installed: installed };

                storeVersionCheck(entry);
                return entry;
            });
        }).then(function(entry) {
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
            self.checkAfterUpdate();
        });

        this.showVersions();
        return this.versionBusy;
    }
});
