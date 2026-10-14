'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require rpc';
'require poll';
'require fs';

// Version and update channel information
const UI_VERSION = 'dev';
const UI_UPD_CHANNEL = 'release';

// ---------------------------------------------------------------------------------------------------------------
// Preset filters. They are offered when a new filter is named, and fill in the protocol and ports for it.
// To add a game or service later, copy one entry and change it:
//   id        short unique id (letters/numbers)
//   label     the name shown in the list (also the default filter name)
//   protocol  'udp' or 'tcp'
//   src_port / dest_port   port numbers, lists ("3074 3075") or ranges ("27015-27020"); leave '' when not used
//   allPlatforms  true when it works on every platform, otherwise list them in `platforms`
//   platforms     e.g. 'PlayStation and Xbox only' (shown when allPlatforms is false)
//   ip_list       server list file for the filter, e.g. '/etc/geomate.d/x_servers.txt' (created empty if it does not exist yet)
//   note          one line shown under the name
// ---------------------------------------------------------------------------------------------------------------
var GEO_PRESETS = [
    {
        id: 'cod',
        label: 'Call of Duty',
        protocol: 'udp',
        src_port: '3074',
        dest_port: '',
        ip_list: '/etc/geomate.d/x_servers.txt',   // the server list file the filter reads (without it the game is not filtered)
        allPlatforms: true,
        platforms: 'PlayStation, Xbox and PC',
        note: 'Game traffic on source port 3074 (UDP).'
    },
    {
        // Every game, whatever port its servers use: all UDP from one device to ports 1024 and up. Left out are the few
        // high ports that are not game servers but console services, which must keep working wherever their server is:
        // 3478-3481 (STUN, NAT type checks), 3544 (Xbox Teredo) and 4500 (IPsec / Xbox party chat). DNS (53), time (123)
        // and QUIC web traffic (443) are below 1024 and so never filtered.
        id: 'anygame',
        label: 'Any Game',   // (also the filter's default name: letters, numbers, spaces and _ . - only)
        protocol: 'udp',
        src_port: '',
        dest_port: '1024-3477 3482-3543 3545-4499 4501-65535',
        ip_list: '/etc/geomate.d/any_game_servers.txt',
        needsSrcIp: true,   // without a device it would filter video calls, VPNs, etc. of every device in the house
        seedFromOthers: true,   // starts with the servers (and locations) the other filters have already learned
        allPlatforms: true,
        platforms: 'PlayStation, Xbox, Switch and PC',
        detailText: 'UDP to any game port (1024 and up) from one device',
        note: 'Pick your console or PC as the source. Keep Strict Mode on for the best performance.'
    }
];

// Source IP: one device, a network, or several devices. The router puts it straight into its firewall rule
// ("ip saddr <value>"), where several addresses must be written as a set: { 192.168.1.50, 192.168.1.60 }.
// On the page they are shown and typed separated by spaces.
function srcIpList(v) {
    return String(Array.isArray(v) ? v.join(' ') : (v == null ? '' : v)).replace(/[{},]/g, ' ').trim().split(/\s+/).filter(Boolean);
}
function srcIpText(v) { return srcIpList(v).join(' '); }
function srcIpForRouter(v) {
    var l = srcIpList(v).filter(function(x, i, a) { return a.indexOf(x) === i; });
    return l.length > 1 ? '{ ' + l.join(', ') + ' }' : (l[0] || '');
}
// Several addresses can't be combined with "!" (not), which only works for a single address or network
function srcIpCheck(v) {
    var l = srcIpList(v);
    if (l.length > 1 && l.some(function(x) { return x.charAt(0) === '!'; }))
        return _('"!" (all except) works with one address or network only, not in a list of several devices');
    return true;
}

function geoPresetText(p) {
    return p.allPlatforms ? 'Works on all platforms (' + p.platforms + ')' : 'Works on: ' + p.platforms + ' only';
}

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

// Throws away configuration changes that were staged ("Unsaved Changes") but not applied yet
var callUciRevert = rpc.declare({
    object: 'uci',
    method: 'revert',
    params: ['config'],
    reject: true
});

// Declare RPC methods to interact with the Geomate backend
// The router's DHCP leases (names and addresses of the devices in the house), to pick the console for a filter
var callDHCPLeases = rpc.declare({
    object: 'luci-rpc',
    method: 'getDHCPLeases',
    expect: { '': {} }
});

var callGeomateConnections = rpc.declare({
    object: 'luci.geomate',
    method: 'getGeomateConnections',
    params: []
});

var callGeomateAllowedIPs = rpc.declare({
    object: 'luci.geomate',
    method: 'getAllowedIPs',
    params: []
});

var callGetHealthCheck = rpc.declare({
    object: 'luci.geomate',
    method: 'getHealthCheck',
    expect: { health: {} }
});

// Function to retrieve the current status of the Geomate service
function getServiceStatus() {
    return fs.exec('/etc/init.d/geomate', ['status']).then(function(res) {
        var output = res.stdout.trim().toLowerCase();
        console.log('Service status output:', output);
        if (res.code === 0 && output.includes('running')) {
            return 'Running';
        } else {
            return 'Not Running';
        }
    }).catch(function(err) {
        console.error('Error getting service status:', err);
        return 'Not Running';
    });
}

// Function to check if /tmp/geomate_loading exists
function getLoadingStatus() {
    return fs.stat('/tmp/geomate_loading').then(function() {
        console.log('Loading file /tmp/geomate_loading is present.');
        return true; // File exists
    }).catch(function(err) {
        // If stat fails, file likely doesn't exist
        return false;
    });
}

// ---- Page-wide handlers: only ever one of each ------------------------------------------------------------------------
// LuCI builds this view again every time you come back to the tab. Handlers added to the page by earlier visits used to stay
// behind, so one click on the full-screen button was handled twice (or three times), toggling fullscreen on and off,
// and every extra copy kept polling the router. Each handler is now registered under a name and replaces the old one.
var geomateBound = {};
function bindOnce(key, target, type, fn, opts) {
    var old = geomateBound[key];
    if (old) { try { old.target.removeEventListener(old.type, old.fn, old.opts); } catch (e) {} }
    target.addEventListener(type, fn, opts);
    geomateBound[key] = { target: target, type: type, fn: fn, opts: opts };
}
var geomateDisposers = {};
function keepOne(key, dispose) {
    if (geomateDisposers[key]) { try { geomateDisposers[key](); } catch (e) {} }
    geomateDisposers[key] = dispose;
}
var geomatePolls = [];
function addPoll(fn, seconds) {
    poll.add(fn, seconds);
    geomatePolls.push(fn);
}
function removeOldPolls() {
    geomatePolls.splice(0).forEach(function(fn) { try { poll.remove(fn); } catch (e) {} });
}

// The live data (connections, allowed IPs) is kept between visits, so coming back to this tab can draw the map at once with
// what was there a moment ago, and the fresh numbers arrive a moment later instead of being waited for.
var geomateCache = { connections: [], allowed: [] };
// Server locations you corrected (from the map's IP history). Kept on the router in this file and written into the filter's
// own location data (<filter>_geo_data.json), which is what the firewall filters by.
var GEO_OVERRIDES_FILE = '/etc/geomate.d/geo_overrides.json';
var geomateOverridesChecked = false;   // corrections re-checked once per page load
var geomateSeedChecked = false;        // empty "Any game" filters filled once per page load
// Servers the filter has seen but not located yet: asked for straight away instead of at Geomate's next 30-minute round
var geomateLocateAsked = {};           // ip -> when it was last asked for
var geomateLocateBusy = false, geomateLocateTimer = null, geomateLocateLast = 0;
var geomateLiveBusy = false;       // one live-data request at a time, across every visit to this tab
var geomateAllowedAt = 0;          // when the allowed IPs were last fetched (they change rarely: every 10 s, or right after a change)
var geomateLiveSkipUntil = 0;      // after a slow answer, wait a while before asking again
var geomateUnloading = false;
// "Fullscreen" = the browser's fullscreen for the whole Geomate page (it stays on when you switch tabs) plus the map stretched over
// the whole screen. The map button (and the Fullscreen choices) turn the stretched map on and off; Esc leaves everything.
// (Fullscreening the map element itself, on top of the page, made the browser keep two fullscreen layers; leaving them in the
//  wrong order made the map disappear.)
var geomateImmersive = false;       // the map is stretched over the screen
var geomateExitKeepsFs = true;      // leaving the stretched map keeps the page fullscreen (true when the page was already fullscreen)
function geomateApplyImmersive(on) {
    var de = document.documentElement;
    if (on) {
        // a page element around the map with a transform / filter would make "fixed to the screen" mean "fixed to that element"
        try {
            for (var el = document.getElementById('geomate-map-container'); el && (el = el.parentElement) && el !== document.documentElement;) {
                var cs = getComputedStyle(el);
                if ((cs.transform && cs.transform !== 'none') || (cs.filter && cs.filter !== 'none') || (cs.perspective && cs.perspective !== 'none') ||
                    (cs.backdropFilter && cs.backdropFilter !== 'none') || /paint|layout|strict|content/.test(cs.contain || '')) el.classList.add('geomate-imm-anc');
            }
        } catch (e) {}
        de.classList.add('geomate-immersive');
    } else de.classList.remove('geomate-immersive');
}
var geomatePseudoFs = false;   // stretched map without browser fullscreen (browsers that have none)
function geomateIsImmersive() { return document.documentElement.classList.contains('geomate-immersive'); }
function geomateViewAlive() { return !!document.getElementById('geomate-map-container'); }
// When the tab is left, LuCI keeps running the polls added by this view. They stop themselves as soon as the map is gone.
function geomateStopIfGone() {
    if (geomateViewAlive()) return false;
    if (geomatePseudoFs) { geomatePseudoFs = false; geomateApplyImmersive(false); }   // the page-wide map is gone: give the page back
    setTimeout(removeOldPolls, 0);
    return true;
}
// Switching between the View and Geo Filters tabs is not "entering Geomate": the stretched map must not come back by itself then,
// or the tab bar (hidden behind it) could never be reached. Clicks on those two tab links are noted here.
var geomateSwapAt = 0;
function geomateWatchTabClicks() {
    bindOnce('tabClicks', document, 'click', function(ev) {
        var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
        if (a && /\/geomate\/(view|geofilters)(\/|\?|#|$)/.test(a.getAttribute('href') || '')) geomateSwapAt = Date.now();
    }, true);
}
function geomateIsTabSwap() { return Date.now() - geomateSwapAt < 20000; }
var FS_WAS_KEY = 'geomateWasFullscreen';   // per tab: was Geomate in fullscreen when the page last went away (Save & Apply reloads it)
function setWasFs(v) { try { sessionStorage.setItem(FS_WAS_KEY, v ? '1' : '0'); } catch (e) {} }
function getWasFs() { try { return sessionStorage.getItem(FS_WAS_KEY) === '1'; } catch (e) { return false; } }

// ---- Fullscreen on entry ----------------------------------------------------------------------------------------------
// Preference (kept in this browser): 'always' = open Geomate in fullscreen every time, 'never' = stay in the window,
// anything else = ask each time. The map's colour menu (the paint palette) changes it too.
var FS_PREF_KEY = 'geomateAutoFullscreen';
function getAutoFsMode() {
    try { var v = localStorage.getItem(FS_PREF_KEY); if (v === 'always' || v === 'never') return v; } catch (e) {}
    return 'ask';
}
function setAutoFsMode(mode) {
    try { if (mode === 'always' || mode === 'never') localStorage.setItem(FS_PREF_KEY, mode); else localStorage.removeItem(FS_PREF_KEY); } catch (e) {}
}

return view.extend({
    geoFilters: {},
    map: null,
    currentConnectionsData: [],
    allowedIPsData: [],

    // Load initial data required for the view
    load: function() {
        // Only the settings are waited for. The connections and allowed IPs come from the last visit and are refreshed once the
        // map is up, so swapping between the View and Geo Filters tabs no longer waits on the (sometimes 10 s) router calls.
        this.currentConnectionsData = geomateCache.connections;
        this.allowedIPsData = geomateCache.allowed;
        this.serviceStatus = this.serviceStatus || 'Not Running';   // refreshed by the status poll
        return uci.load('geomate').then(function(cfg) {
            return [cfg, { connections: geomateCache.connections }, { allowed_ips: geomateCache.allowed }, null];
        }).catch(function(error) {
            console.error('Error loading data:', error);
            return [null, { connections: [] }, { allowed_ips: [] }, null];
        });
    },

    // Render the form and map interface
    render: function(data) {
        var self = this;
        var m, s, o;
        var geomateConfig = data[0];

        // We only handle connectionsResult, allowedIPsResult after map is ready
        // to prevent heavy parallel load
        var connectionsResult = data[1];
        var allowedIPsResult = data[2];
        // We'll defer serviceStatus calls to after mapReady event
        // var serviceStatus = data[3]; // remove immediate usage

        this.currentConnectionsData = connectionsResult.connections || [];
        this.allowedIPsData = allowedIPsResult.allowed_ips || [];
        // No immediate console here for serviceStatus; wait until poll

        m = new form.Map('geomate', '', '');

        // Section to display the current status of the Geomate service
        s = m.section(form.TypedSection, '_service_status', _('Service Status'));
        s.anonymous = true;
        s.render = function() {
            var statusColor = self.serviceStatus === 'Running' ? 'green' : 'red';
            var statusText = self.serviceStatus === 'Running' ? _('Running') : _('Not Running');
        
            return E('div', { 'class': 'geomate-status-block', style: 'display: flex; flex-direction: column; margin-left: 8px;' }, [
                // Service status + Health checks row (combined)
                E('div', { style: 'display: flex; align-items: center; flex-wrap: wrap; gap: 8px;' }, [
                    // Colored circle + status text
                    E('div', { style: 'display: flex; align-items: center;' }, [
                        E('div', {
                            id: 'service-status-indicator',
                            style: `
                                width: 12px;
                                height: 12px;
                                border-radius: 50%;
                                background-color: ${statusColor};
                                margin-right: 8px;
                            `
                        }),
                        E('span', { id: 'service-status-text', style: 'margin: 0; font-weight: bold;' }, statusText)
                    ]),
                    // Health check status (inline)
                    E('span', { 
                        id: 'health-check-status',
                        style: 'font-size: 13px; margin-left: 8px;'
                    }, ''),
                    // Loading message (hidden by default)
                    E('span', {
                        id: 'geomate-loading-indicator',
                        style: 'display: none; color: orange; margin-left: 8px;'
                    }, _('Loading GeoFilter data ...'))
                ]),
                // Operational mode row
                E('div', { 
                    id: 'operational-mode-container',
                    style: 'margin-top: 8px; display: none; justify-content: space-between; align-items: center;' 
                }, [
                    E('p', { 
                        id: 'operational-mode-text',
                        style: 'margin: 0; font-weight: normal;'
                    }, ''),
                    E('div', { 
                        style: 'font-size: 13px; color: #6b7280;' 
                    }, [
                        E('span', {
                            id: 'version-display',
                            style: 'color: #6b7280;'
                        }, _('Loading version...')),
                        E('span', { 
                            id: 'version-update-status',
                            style: 'margin-left: 8px; font-style: italic;'
                        }, '')
                    ])
                ])
            ]);
        };

        // Section to embed the map interface
        s = m.section(form.TypedSection, '_map', _('Map'));
        s.anonymous = true;
        s.render = function() {
            return E('div', { id: 'geomate-map-container', style: 'position: relative; isolation: isolate;' }, [
                E('iframe', {
                    src: L.resource('view/geomate/map.html') + '?v=gl60&t=' + Date.now(), // version tag: makes the browser fetch a fresh map.html after an update
                    style: 'width: 100%; height: 65vh; border: none;' // height is fitted to the window by fitMapToWindow()
                })
            ]);
        };

        // (The old "Active Connections" table is gone: the map's IP history lists the same addresses - its "Now" tab
        // shows the ones connected right now, with their filter and status.)

        return m.render().then(function(rendered) {
            rendered.classList.add('geomate-dumaos-theme');
            // The stylesheet lives in <head> (not inside the form), so it survives the form being re-rendered, e.g. by Reset
            var themeCss = `
/* DumaOS-inspired presentation only */
.geomate-dumaos-theme{--gm-panel:#17232d;--gm-border:#30414d;--gm-text:#eaf1f5;--gm-muted:#9eafb9;--gm-accent:#9bdc28;color:var(--gm-text)}
.geomate-dumaos-theme .cbi-section,.geomate-dumaos-theme .cbi-section-node{background:var(--gm-panel)!important;color:var(--gm-text)!important;border:1px solid var(--gm-border)!important;border-radius:10px!important;padding:16px!important;margin:12px 0 18px!important;box-shadow:0 6px 20px rgba(0,0,0,.16)}
.geomate-dumaos-theme .cbi-section h3,.geomate-dumaos-theme .cbi-section .cbi-section-title{color:var(--gm-text)!important;font-size:1.05rem;font-weight:700;letter-spacing:.02em}
.geomate-dumaos-theme #geomate-map-container{overflow:hidden;border:1px solid #344651;border-left:0;border-right:0;border-radius:0;background:#0b1117;box-shadow:0 10px 28px rgba(0,0,0,.28);box-sizing:border-box}
.geomate-dumaos-theme #geomate-map-container iframe{display:block;border-radius:0;min-height:380px}
@media (max-width:700px),(max-height:500px){.geomate-dumaos-theme #geomate-map-container iframe{min-height:240px}}
.geomate-dumaos-theme #geomate-map-container:fullscreen{background:#0b1117;border:0;border-radius:0;width:100%!important;height:100%!important;margin-left:0!important;transform:none!important;left:0!important}
.geomate-dumaos-theme #geomate-map-container:fullscreen iframe{height:100%!important;width:100%!important;border-radius:0}
.geomate-dumaos-theme #service-status-indicator{box-shadow:0 0 0 4px rgba(155,220,40,.12)}
.geomate-dumaos-theme #service-status-text{color:var(--gm-text);letter-spacing:.04em;text-transform:uppercase;font-size:.85rem}
.geomate-dumaos-theme #health-check-status,.geomate-dumaos-theme #version-display,.geomate-dumaos-theme #version-update-status{color:var(--gm-muted)!important}
.geomate-dumaos-theme #operational-mode-container{display:none!important}
.geomate-dumaos-theme .cbi-section:has(#service-status-indicator){display:none!important}
.geomate-dumaos-theme #service-status-indicator{display:none!important}
.geomate-dumaos-theme .cbi-button,.geomate-dumaos-theme button{border-radius:6px}
.geomate-dumaos-theme input,.geomate-dumaos-theme select,.geomate-dumaos-theme textarea{border-radius:6px!important}

/* the map stretched over the whole screen (see geomateImmersive) */
html.geomate-immersive,html.geomate-immersive body{overflow:hidden!important}
html.geomate-immersive #geomate-map-container{position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;height:100dvh!important;max-width:none!important;margin:0!important;padding:0!important;transform:none!important;border:0!important;border-radius:0!important;z-index:2147483000!important;background:#0b1117!important}
html.geomate-immersive .geomate-imm-anc{transform:none!important;filter:none!important;perspective:none!important;backdrop-filter:none!important;contain:none!important;overflow:visible!important}
html.geomate-immersive #geomate-map-container iframe{position:absolute!important;top:0!important;left:0!important;width:100%!important;height:100%!important;min-height:0!important;border-radius:0!important}

/* the status rows stay hidden, however the page is re-rendered */
#operational-mode-container{display:none!important}
.cbi-section:has(#service-status-indicator){display:none!important}
.geomate-status-block{display:none!important}
.cbi-section:has(> .geomate-status-block){display:none!important}
`;
            var oldThemeStyle = document.getElementById('geomate-theme-style');
            if (oldThemeStyle) oldThemeStyle.parentNode.removeChild(oldThemeStyle);
            document.head.appendChild(E('style', { id: 'geomate-theme-style' }, themeCss));
            self.map = m;
            removeOldPolls();
            self._pageFs = document.fullscreenElement === document.documentElement;
            bindOnce('pagehide', window, 'pagehide', function() { geomateUnloading = true; });
            bindOnce('beforeunload', window, 'beforeunload', function() { geomateUnloading = true; setTimeout(function() { geomateUnloading = false; }, 2500); });
            geomateWatchTabClicks();
            self.setupMessageHandlers();
            self.startFullscreenOnEntry();
        
            // Hide the "Running / Config / Files ..." status section entirely (it is still updated in the background)
            self.hideStatusSection = function(root) {
                var statusText = (root || document).querySelector('#service-status-text');
                if (!statusText) return;
                var statusSection = statusText;
                while (statusSection.parentElement && statusSection.parentElement !== root &&
                       !statusSection.classList.contains('cbi-section')) {
                    statusSection = statusSection.parentElement;
                }
                // never hide anything that also holds the map
                if (!statusSection.querySelector('#geomate-map-container')) {
                    statusSection.style.display = 'none';
                }
            };
            self.hideStatusSection(rendered);
            try {
                new MutationObserver(function() {
                    var t = rendered.querySelector('#service-status-text');
                    if (t && !t.closest('.geomate-status-block')) self.hideStatusSection(rendered);
                }).observe(rendered, { childList: true, subtree: true });
            } catch (e) {}

            var mapIframe = rendered.querySelector('#geomate-map-container iframe');
            var originalMapHeight = null;
        
            if (mapIframe) {
                originalMapHeight = mapIframe.style.height || getComputedStyle(mapIframe).height;
            }
        
            // Use the whole browser width, and a height that leaves room for Save & Apply, so the page needn't scroll.
            //
            // The map box is made as wide as the window and slid left by the distance between the page's column and the
            // window edge. Several ways of sliding it are tried in turn (a CSS transform, then `left`, then a negative
            // margin) and each result is measured, because themes differ: some animate every property change (so a
            // measurement taken straight away still sees the old position), and some ignore one technique or another.
            // Animations are switched off on the box, a partial slide is corrected, and if nothing can be confirmed to
            // span the window, the box stays in its normal column, so the map is never lost off-screen.
            var fitState = { sig: '', gaveUp: false };
            function viewSig() {
                return document.documentElement.clientWidth + 'x' + window.innerHeight + 'x' + window.devicePixelRatio;
            }
            // A LuCI dialog (e.g. the filter settings window) covers the map and removes the page scrollbar. Measuring the map
            // then makes it look hidden, and the fit would wrongly shrink it to a narrow column behind the dialog.
            function modalOpen() {
                return document.body.classList.contains('modal-overlay-active') || !!document.querySelector('#modal_overlay.modal-overlay-active');
            }
            self.fitMapToWindow = function() {
                var box = document.getElementById('geomate-map-container');
                var frame = box && box.querySelector('iframe');
                if (!box || !frame || document.fullscreenElement === box || geomateIsImmersive()) return;   // (the stretched map needs no fitting)
                if (modalOpen()) return;
                var de = document.documentElement;
                de.style.overflowX = 'hidden'; // never show a sideways scrollbar for a few pixels of rounding
                // Themes often put `transition: all` on everything; that would make the box glide into place and be measured mid-way
                box.style.setProperty('transition', 'none', 'important');
                box.style.setProperty('animation', 'none', 'important');

                var STRATEGIES = {
                    transform: function(shift) { box.style.transform = 'translateX(' + shift + 'px)'; },
                    left:      function(shift) { box.style.position = 'relative'; box.style.left = shift + 'px'; },
                    margin:    function(shift) { box.style.marginLeft = shift + 'px'; }
                };
                var ORDER = ['transform', 'left', 'margin'];

                function natural() {
                    box.style.width = '';
                    box.style.transform = '';
                    box.style.left = '';
                    box.style.marginLeft = '0px';
                    if (window.pageXOffset) window.scrollTo(0, window.pageYOffset);
                }
                function placed() {
                    var r = box.getBoundingClientRect();
                    return Math.abs(r.left) < 1.5 && Math.abs(r.right - de.clientWidth) < 1.5;
                }
                // Is the map really on screen? (a box can be measured in the right place yet hidden, e.g. clipped by the page)
                function reallyVisible() {
                    var r = box.getBoundingClientRect();
                    var y = Math.min(Math.max(r.top + Math.min(r.height / 2, 200), 0), window.innerHeight - 1);
                    var xs = [0.25, 0.5, 0.75].map(function(f) { return Math.min(Math.max(r.left + r.width * f, 0), de.clientWidth - 1); });
                    return xs.some(function(x) {
                        var el = document.elementFromPoint(x, y);
                        return !!el && box.contains(el);
                    });
                }

                natural();
                var actions = document.querySelector('.cbi-page-actions');
                var reserve = actions ? actions.offsetHeight + 40 : 110;
                var top = box.getBoundingClientRect().top + window.pageYOffset;
                var minH = (window.innerWidth < 700 || window.innerHeight < 500) ? 240 : 380;   // phones: a smaller map rather than a page that scrolls
                frame.style.height = Math.max(minH, Math.floor(window.innerHeight - top - reserve)) + 'px';

                // Setting the height can make a classic (Windows) scrollbar appear and narrow the window,
                // so the width is set afterwards, and the whole placement is repeated once in case that changed.
                var ok = false, used = '', trail = [];
                for (var attempt = 0; attempt < 2 && !ok; attempt++) {
                    for (var i = 0; i < ORDER.length && !ok; i++) {
                        natural();
                        box.style.width = de.clientWidth + 'px';
                        var off = box.getBoundingClientRect().left + window.pageXOffset; // where the box starts, from the page's left edge
                        var shift = -off;
                        STRATEGIES[ORDER[i]](shift);
                        var r = box.getBoundingClientRect();
                        if (Math.abs(r.left) >= 1.5 && Math.abs(r.left) < 3000) {   // only partly applied: correct by what is left over
                            shift -= r.left;
                            STRATEGIES[ORDER[i]](shift);
                        }
                        ok = placed() && reallyVisible();
                        trail.push(ORDER[i] + (ok ? ':ok' : ':' + Math.round(box.getBoundingClientRect().left)));
                        if (ok) used = ORDER[i];
                    }
                }
                // Some themes clip the page a little before the window edge (a frame or border on the right). The map then looked
                // full width but its right-most strip was hidden (cutting off the map credits and Google's "Terms" link).
                // Find the right-most point that is really visible and end the map there.
                fitState.trim = 0;
                if (ok) {
                    var rr = box.getBoundingClientRect();
                    var ys = [rr.top + Math.min(rr.height - 2, 40), rr.top + rr.height / 2, rr.bottom - 6].map(function(y) {
                        return Math.min(Math.max(y, 0), window.innerHeight - 1);
                    });
                    var seen = function(x) {
                        return ys.every(function(y) { var el = document.elementFromPoint(x, y); return !!el && box.contains(el); });
                    };
                    var edge = Math.min(rr.right, de.clientWidth) - 1;
                    if (!seen(edge)) {
                        var lo = rr.left + rr.width * 0.75, hi = edge;     // lo is visible (checked above), hi is not
                        if (seen(lo)) {
                            while (hi - lo > 1) { var mid = Math.floor((lo + hi) / 2); if (seen(mid)) lo = mid; else hi = mid; }
                            var trim = Math.ceil(rr.right - (lo + 1));
                            if (trim > 0 && trim < 200) {
                                box.style.width = (rr.width - trim) + 'px';
                                fitState.trim = trim;
                            }
                        }
                    }
                }
                var before = box.getBoundingClientRect();
                if (!ok) {
                    natural();            // could not span the window on this page: keep the map in its normal column
                    fitState.gaveUp = true;
                } else {
                    fitState.gaveUp = false;
                }
                fitState.sig = viewSig();
                // Short diagnostic line (first few runs and whenever the outcome changes), to help trace layout problems
                var outcome = ok ? 'full width (' + used + ')' : 'normal column';
                var summary = outcome + ' | window ' + de.clientWidth + 'x' + window.innerHeight +
                              ' | dpr ' + window.devicePixelRatio + ' | box ' + Math.round(before.left) + '..' + Math.round(before.right) +
                              ' | tried ' + trail.join(',') + (fitState.trim ? ' | right edge hidden by the page: map ended ' + fitState.trim + 'px early' : '');
                fitState.logged = (fitState.logged || 0) + 1;
                if (fitState.logged <= 6 || fitState.lastSummary !== outcome) {
                    console.log('[geomate] map fit v4: ' + summary);
                }
                fitState.lastSummary = outcome;
                if (window.pageXOffset) window.scrollTo(0, window.pageYOffset);
            };
            setTimeout(self.fitMapToWindow, 50);
            setTimeout(self.fitMapToWindow, 500);
            // When a dialog closes, fit again (the page scrollbar comes back)
            try {
                var wasModal = false;
                var modalObserver = new MutationObserver(function() {
                    var now = modalOpen();
                    if (wasModal && !now) { setTimeout(self.fitMapToWindow, 50); setTimeout(self.fitMapToWindow, 400); }
                    wasModal = now;
                });
                modalObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
                keepOne('modalObserver', function() { modalObserver.disconnect(); });
            } catch (e) {}
            bindOnce('resize', window, 'resize', function() { self.fitMapToWindow(); });
            // The page never needs to scroll sideways; undo any sideways scroll the browser applies while zooming
            bindOnce('scroll', window, 'scroll', function() { if (window.pageXOffset) window.scrollTo(0, window.pageYOffset); }, { passive: true });
            // Browser zoom (Ctrl +/-) and scrollbars appearing change the usable width, not always with a window resize event
            if (window.visualViewport) bindOnce('viewport', window.visualViewport, 'resize', function() { self.fitMapToWindow(); });
            if (window.ResizeObserver) {
                var docObserver = new ResizeObserver(function() {
                    if (viewSig() !== fitState.sig) self.fitMapToWindow();
                });
                docObserver.observe(document.documentElement);
                keepOne('docObserver', function() { docObserver.disconnect(); });
            }
            // Safety net, read-only unless something is wrong: if the window changed without the page being told,
            // or the map has drifted off-position, fit again. After a failed fit it waits for the window to change.
            var fitTimer = setInterval(function() {
                var box = document.getElementById('geomate-map-container');
                if (document.hidden || !box || document.fullscreenElement === box || geomateIsImmersive()) return;
                if (viewSig() !== fitState.sig) { self.fitMapToWindow(); return; }
                if (fitState.gaveUp) return;
                var r = box.getBoundingClientRect(), w = document.documentElement.clientWidth;
                if (Math.abs(r.left) >= 1.5 || Math.abs(r.right - (w - (fitState.trim || 0))) >= 1.5) self.fitMapToWindow();
            }, 1000);
            keepOne('fitTimer', function() { clearInterval(fitTimer); });
            // Entering or leaving fullscreen changes the window size a moment after the event, so fit again a few times
            // and make the map re-measure itself, so it never stays at the old size ("going back doesn't fix it")
            bindOnce('fullscreenchange', document, 'fullscreenchange', function() {
                var fe = document.fullscreenElement;
                var box = document.getElementById('geomate-map-container');
                if (fe) self.hideFullscreenPrompt(); else { self._pageFs = false; geomateImmersive = false; }
                // the stretched map follows the browser's fullscreen: on when it was asked for, off as soon as fullscreen ends (Esc)
                geomateApplyImmersive(!!fe && geomateImmersive);
                if (fe) setWasFs(true); else if (!geomateUnloading) setWasFs(false);   // leaving because the page is reloading doesn't count
                var refit = function() {
                    var b = document.getElementById('geomate-map-container');
                    if (b && !geomateIsImmersive()) { self.fitMapToWindow(); }
                    var f = document.querySelector('#geomate-map-container iframe');
                    if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'refreshMapSize' }, '*');
                };
                if (box && !geomateIsImmersive()) { box.style.width = ''; box.style.transform = ''; box.style.left = ''; box.style.marginLeft = '0px'; }
                [0, 150, 500, 1200, 2200].forEach(function(ms) { setTimeout(refit, ms); });
            });

            // Send initial connections and Allowed IPs to the map after the map is ready
            bindOnce('messageRender', window, 'message', function(event) {
                if (event.data && event.data.type === 'mapReady') {
                    console.log('Map is ready, loading data');
                    self.loadGeoFilters()
                        .then(() => {
                            self.sendAllowedIPsToMap(self.allowedIPsData || []);
                            self.sendConnectionsToMap(self.currentConnectionsData || []);
                            self.updateActiveConnectionsList();
                            // the up-to-date numbers, fetched now that the map is on screen
                            if (self.pollLive) self.pollLive();
                            // Initial version check
                            self.checkForUpdates();
                        });

                    // Regularly update the service status - only after map is ready (only once, even if the map reloads)
                    if (!self._pollsAdded) {
                    self._pollsAdded = true;
                    var statusBusy = false;
                    addPoll(function() {
                        // Never start a new status check while the last one is still running (a slow router would pile them up),
                        // and don't bother while this tab is in the background.
                        if (geomateStopIfGone()) return Promise.resolve();
                        if (statusBusy || document.hidden) return Promise.resolve();
                        statusBusy = true;
                        return Promise.all([
                            getServiceStatus(),
                            getLoadingStatus(),
                            uci.load('geomate').then(function() {
                                var globalConfig = uci.sections('geomate', 'global')[0];
                                return globalConfig ? globalConfig.operational_mode : 'dynamic';
                            }),
                            callGetHealthCheck()
                        ]).then(function(results) {
                            var serviceStatus = results[0];
                            var loadingStatus = results[1];
                            var operationalMode = results[2];
                            var healthData = results[3] || {};
                            self.serviceStatus = serviceStatus;

                            var statusElement = document.getElementById('service-status-text');
                            var indicatorElement = document.getElementById('service-status-indicator');
                            var loadingElement = document.getElementById('geomate-loading-indicator');
                            var modeContainer = document.getElementById('operational-mode-container');
                            var modeElement = document.getElementById('operational-mode-text');
                            var healthElement = document.getElementById('health-check-status');

                            if (statusElement) {
                                var statusText = (serviceStatus === 'Running') ? _('Running') : _('Not Running');
                                statusElement.textContent = statusText;
                            }

                            if (indicatorElement) {
                                var statusColor = (serviceStatus === 'Running') ? 'green' : 'red';
                                indicatorElement.style.backgroundColor = statusColor;
                            }

                            // Show or hide the loading message                            
                            if (loadingElement) {
                                if (loadingStatus === true) {
                                    loadingElement.style.display = 'inline';
                                } else {
                                    loadingElement.style.display = 'none';
                                }
                            }

                            // Show health check status (inline with Running)
                            if (healthElement && healthData.checks) {
                                var checks = healthData.checks;
                                var html = '';
                                
                                // Build compact health check display
                                var checkOrder = ['config', 'files', 'datadir', 'service', 'nft'];
                                var checkLabels = {
                                    'config': 'Config',
                                    'files': 'Files', 
                                    'datadir': 'Data',
                                    'service': 'Autostart',
                                    'nft': 'nftables'
                                };
                                
                                checkOrder.forEach(function(key) {
                                    if (checks[key]) {
                                        var check = checks[key];
                                        var icon = '✓';
                                        var color = '#10b981'; // green
                                        
                                        if (check.status === 'error') {
                                            icon = '✗';
                                            color = '#ef4444'; // red
                                        } else if (check.status === 'warning') {
                                            icon = '⚠';
                                            color = '#f59e0b'; // orange
                                        } else if (check.status === 'info') {
                                            icon = '○';
                                            color = '#6b7280'; // gray
                                        }
                                        
                                        html += '<span style="margin-right: 10px;" title="' + (check.message || '') + '">';
                                        html += '<span style="color: ' + color + ';">' + icon + '</span> ';
                                        html += checkLabels[key] || key;
                                        html += '</span>';
                                    }
                                });
                                
                                healthElement.innerHTML = html;
                            }

                            // Show operational mode
                            if (modeContainer && modeElement) {
                                var modeText = '';
                                var modeStyle = '';
                                
                                if (operationalMode === 'monitor') {
                                    modeText = _('Mode: Monitor Only - Connections are tracked but NOT blocked');
                                    modeStyle = 'color: orange; font-weight: bold;';
                                } else if (operationalMode === 'static') {
                                    modeText = _('Mode: Static - Using predefined IP lists');
                                    modeStyle = 'color: blue;';
                                } else {
                                    modeText = _('Mode: Dynamic - Building IP lists automatically');
                                    modeStyle = 'color: green;';
                                }
                                
                                modeElement.textContent = modeText;
                                modeElement.style.cssText = 'margin: 0; ' + modeStyle;
                            }
                        }).then(function() { statusBusy = false; }, function(err) { statusBusy = false; throw err; });
                    }, 30); // service status every 30 s (the status block is hidden; this is only a light safety refresh)econds

                    // Polling connections+allowedIPs
                    self.pollLive = function() {
                        // One request at a time, across every visit to this tab: when the router is slow, new polls used to pile up
                        // behind the old ones and hold up everything else the page was loading. Not while this tab is in the
                        // background, and not once the map is gone (the poll used to keep running on the Geo Filters tab).
                        if (geomateStopIfGone()) return Promise.resolve();
                        if (geomateLiveBusy || document.hidden || Date.now() < geomateLiveSkipUntil) return Promise.resolve();
                        geomateLiveBusy = true;
                        var t0 = Date.now();
                        var wantAllowed = Date.now() - geomateAllowedAt >= 10000;
                        return Promise.all([
                            callGeomateConnections(),
                            wantAllowed ? callGeomateAllowedIPs() : Promise.resolve(null)
                        ]).then(function(results) {
                            var connectionsData = results[0].connections || [];
                            if (results[1]) geomateAllowedAt = Date.now();
                            var allowedIPsData = results[1] ? (results[1].allowed_ips || []) : (geomateCache.allowed || []);
                            geomateCache.connections = connectionsData;
                            geomateCache.allowed = allowedIPsData;
                            if (!geomateViewAlive()) return;
                            self.currentConnectionsData = connectionsData;
                            self.allowedIPsData = allowedIPsData;
                            self.sendConnectionsToMap(connectionsData);
                            self.sendAllowedIPsToMap(allowedIPsData);
                            self.updateActiveConnectionsList();
                            // (a router with the updated luci.geomate sorts new servers itself, every second)
                            if (!results[0].fast_locate) self.locatePendingSoon(connectionsData);
                        }).catch(function(error) {
                            console.error('Error fetching data:', error);
                        }).then(function() {
                            geomateLiveBusy = false;
                            // a slow router gets time to breathe: wait as long as the last answer took before asking again
                            var took = Date.now() - t0;
                            geomateLiveSkipUntil = took > 2500 ? Date.now() + took : 0;
                        });
                    };
                    addPoll(self.pollLive, 1); // every second (cheap: the router's helper keeps a summary the request just reads)
                    // "Fast detection" (Geo Filters -> Global Settings): also ask in between, so the map updates every half second
                    // (one request at a time still: pollLive skips while the last one is running)
                    keepOne('fastLive', null);
                    if (uci.get('geomate', 'global', 'fast_detection') === '1') {
                        var fastLiveTimer = setInterval(function() {
                            if (!geomateViewAlive()) { clearInterval(fastLiveTimer); return; }
                            self.pollLive();
                        }, 500);
                        keepOne('fastLive', function() { clearInterval(fastLiveTimer); });
                    }

                    // Check for version updates every 60 minutes
                    addPoll(function() {
                        if (geomateStopIfGone()) return Promise.resolve();
                        return self.checkForUpdates();
                    }, 3600); // 3600 seconds
                    }
                }
            }, false);

            return rendered;
        });
    },


    // Open the map in fullscreen when the page is entered, as the saved preference says. Browsers only allow fullscreen
    // right after a click or key press, so it is asked for as soon as the page is on screen (the click on the menu is still
    // fresh then). When that is too late - the page was reloaded by Save & Apply, say - the first click anywhere does it.
    startFullscreenOnEntry: function() {
        var self = this, tries = 0;
        if (self._autoFsHandled) return;
        (function wait() {
            if (self._autoFsHandled) return;
            if (document.getElementById('geomate-map-container')) { self._autoFsHandled = true; self.autoFullscreenOnEntry(); return; }
            if (++tries < 60) setTimeout(wait, 50);
        })();
    },

    autoFullscreenOnEntry: function() {
        var self = this;
        var box = document.getElementById('geomate-map-container');
        if (!box || !document.documentElement.requestFullscreen || document.fullscreenEnabled === false) return;
        var mode = getAutoFsMode();
        if (mode === 'never') return;
        if (geomateIsTabSwap()) return;                         // only a switch between the View and Geo Filters tabs: leave things as they are
        if (document.fullscreenElement) {
            // the page is still fullscreen from the last visit (fullscreen carries over when you go to another LuCI page and back):
            // with "always", the map is stretched over the screen again
            if (mode === 'always' && !geomateIsImmersive()) self.enterFullscreen();
            return;
        }
        // "Always", or it was fullscreen a moment ago (this page was just reloaded, e.g. by Save & Apply): go back to it
        // without asking again.
        if (mode === 'always' || getWasFs()) {
            self.enterFullscreen().then(function() {
                if (!document.fullscreenElement) self.showFullscreenPrompt('click');
            });
        } else {
            self.showFullscreenPrompt('ask');
        }
    },

    // Fullscreen for the whole page, with the map stretched over it. keepFsOnExit: leaving the stretched map (map button) leaves the
    // page fullscreen (used when it was opened automatically); otherwise it leaves fullscreen altogether.
    enterFullscreen: function(keepFsOnExit) {
        var self = this;
        var docEl = document.documentElement;
        this.hideFullscreenPrompt();
        geomateImmersive = true;
        geomateExitKeepsFs = keepFsOnExit !== false;
        if (document.fullscreenElement) { self.setImmersive(true); return Promise.resolve(); }
        if (!docEl.requestFullscreen) {
            // No fullscreen in this browser (iPhone Safari): stretch the map over the whole page instead
            geomatePseudoFs = true;
            self.setImmersive(true);
            return Promise.resolve();
        }
        if (docEl.requestFullscreen) {
            self._pageFs = true;
            var p;
            try { p = docEl.requestFullscreen({ navigationUI: 'hide' }); } catch (e) { try { p = docEl.requestFullscreen(); } catch (e2) { p = Promise.reject(e2); } }
            return p.catch(function(err) { self._pageFs = false; geomateImmersive = false; console.warn('Fullscreen request failed:', err); });
        }
        return Promise.resolve();
    },

    // Stretch the map over the screen / put it back (the browser stays fullscreen)
    setImmersive: function(on) {
        var self = this;
        geomateImmersive = !!on;
        if (!on) geomatePseudoFs = false;
        geomateApplyImmersive(!!on && (!!document.fullscreenElement || geomatePseudoFs));
        var after = function() {
            var f = document.querySelector('#geomate-map-container iframe');
            if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'refreshMapSize' }, '*');
            if (!geomateIsImmersive() && self.fitMapToWindow) self.fitMapToWindow();
        };
        [0, 150, 500, 1200, 2200].forEach(function(ms) { setTimeout(after, ms); });
    },

    hideFullscreenPrompt: function() {
        var old = document.getElementById('geomate-fs-prompt');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        this._fsArmed = false;
        var iframe = document.querySelector('#geomate-map-container iframe');
        if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'armFullscreenGesture', on: false }, '*');
    },

    // kind 'ask': "Open in fullscreen?" with choices. kind 'click': the browser needs a click first, so the first click anywhere does it.
    showFullscreenPrompt: function(kind) {
        var self = this;
        var box = document.getElementById('geomate-map-container');
        if (!box) return;
        self.hideFullscreenPrompt();

        var card = document.createElement('div');
        card.id = 'geomate-fs-prompt';
        card.style.cssText = 'position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:3000;max-width:92%;' +
            'background:rgba(23,35,45,.97);color:#eaf1f5;border:1px solid #30414d;border-radius:10px;padding:10px 14px;' +
            'box-shadow:0 10px 30px rgba(0,0,0,.45);font:13px/1.4 sans-serif;text-align:center';
        var title = document.createElement('div');
        title.style.cssText = 'font-weight:600;margin-bottom:8px';
        title.textContent = kind === 'click' ? 'Click anywhere to open Geomate in fullscreen' : 'Open Geomate in fullscreen?';
        card.appendChild(title);

        function btn(label, tip, primary, fn) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.title = tip;
            b.style.cssText = 'margin:0 4px 4px;padding:5px 12px;border-radius:6px;cursor:pointer;font:600 12px sans-serif;' +
                (primary ? 'background:#3b82f6;color:#fff;border:1px solid #3b82f6' : 'background:#0f1921;color:#eaf1f5;border:1px solid #3a4d59');
            b.addEventListener('click', function(ev) { ev.preventDefault(); ev.stopPropagation(); fn(); });
            card.appendChild(b);
        }
        if (kind === 'click') {
            btn('Fullscreen', 'Open in fullscreen now', true, function() { self.enterFullscreen(); });
            btn('Not now', 'Stay in the window this time', false, function() { self.hideFullscreenPrompt(); });
        } else {
            btn('Fullscreen', 'Open in fullscreen this time only', true, function() { self.enterFullscreen(); });
            btn('Always', 'Always open Geomate in fullscreen (saved in this browser)', false, function() { setAutoFsMode('always'); self.enterFullscreen(); });
            btn('Not now', 'Stay in the window this time (you will be asked again next time)', false, function() { self.hideFullscreenPrompt(); });
            btn('Never', 'Stay in the window and do not ask again (saved in this browser)', false, function() { setAutoFsMode('never'); self.hideFullscreenPrompt(); });
            var note = document.createElement('div');
            note.style.cssText = 'font-size:11px;color:#9eafb9;margin-top:2px';
            note.textContent = 'You can change this any time in the colours menu on the map (palette button).';
            card.appendChild(note);
        }
        box.appendChild(card);

        if (kind === 'click') {
            // First click or key press anywhere (on this page, or inside the map) opens fullscreen
            self._fsArmed = true;
            var iframe = document.querySelector('#geomate-map-container iframe');
            if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'armFullscreenGesture', on: true }, '*');
            var evs = ['pointerdown', 'click', 'keydown', 'touchend'];
            var off = function() { evs.forEach(function(t) { document.removeEventListener(t, once, true); }); };
            var once = function(ev) {
                if (!self._fsArmed) { off(); return; }
                if (card.contains(ev.target)) return;      // the card's own buttons do their own thing
                if (ev.type === 'keydown' && (ev.key === 'Escape' || ev.key === 'Shift' || ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Meta')) return;
                off();
                self.enterFullscreen();
            };
            evs.forEach(function(t) { document.addEventListener(t, once, true); });
        }
    },

    // Set up handlers for messages received from the map iframe
    setupMessageHandlers: function() {
        var self = this;
        bindOnce('messageMain', window, 'message', function(event) {
            if (!event.data || typeof event.data !== 'object') return;
            console.log('Received message from iframe:', event.data);
            if (event.data.type === 'mapReady') {
                console.log('Map is ready, loading geo filters');
                self.sendMessageToMap('setPresets', { data: GEO_PRESETS.map(function(p) {
                    return { id: p.id, label: p.label, allPlatforms: !!p.allPlatforms, platformText: geoPresetText(p),
                             detail: p.detailText || (p.protocol.toUpperCase() + (p.src_port ? ' · source port ' + p.src_port : '') + (p.dest_port ? ' · destination port ' + p.dest_port : '') + (p.ip_list ? ' · IP list ' + p.ip_list : '')),
                             note: p.note || '' };
                }) });
                if (!self._autoFsHandled) { self._autoFsHandled = true; self.autoFullscreenOnEntry(); }   // (normally already done when the page appeared)
                self.loadGeoFilters()
                    .then(() => {
                        self.sendConnectionsToMap(self.currentConnectionsData || []);
                        self.sendAllowedIPsToMap(self.allowedIPsData || []);
                        self.updateActiveConnectionsList();
                        self.sendDeniedToMap();
                        return self.fixInvalidFilterNames()
                            .then(function() { return self.reapplyGeoOverrides(); })
                            .then(function() { return self.seedEmptyAnyGameFilters(); });
                    });
            } else if (event.data.type === 'userGesture') {
                if (self._fsArmed) self.enterFullscreen();
            } else if (event.data.type === 'regionCreated') {
                console.log('New geo filter:', event.data.data);
                self.updateGeoFilter(event.data.data.name, null, event.data.data.region, true, event.data.data.preset);
            } else if (event.data.type === 'regionEdited') {
                console.log('Updating geo filter:', event.data.data);
                var data = event.data.data;
                self.updateGeoFilter(data.name, data.oldRegion, data.region, false);
            } else if (event.data.type === 'regionDeleted') {
                console.log('Deleting geo filter:', event.data.data.name, event.data.data.region);
                // The map has removed the shape itself (and shows each shape once); no need to reload every region
                self.deleteGeoFilter(event.data.data.name, event.data.data.region)
                    .catch(error => {
                        console.error('Error deleting region:', error);
                    });
            } else if (event.data.type === 'toggleMapFullscreen') {
                var nowMs = Date.now();
                if (self._lastFsToggle && nowMs - self._lastFsToggle < 600) return;   // a double click must not undo itself
                self._lastFsToggle = nowMs;
                if (geomateIsImmersive()) {
                    // back from the stretched map: to the page if it was already fullscreen, out of fullscreen if the button started it
                    if (geomateExitKeepsFs) self.setImmersive(false);
                    else { geomateImmersive = false; if (document.fullscreenElement) document.exitFullscreen().catch(function() {}); else self.setImmersive(false); }
                } else {
                    self.enterFullscreen(!!document.fullscreenElement);
                }
            } else if (event.data.type === 'setGeoOverride' || event.data.type === 'clearGeoOverride') {
                self.setGeoOverride(event.data.data || {}, event.data.type === 'clearGeoOverride');
            } else if (event.data.type === 'denyIPs' || event.data.type === 'undenyIPs') {
                self.setIPsDenied((event.data.data && event.data.data.items) || [], event.data.type === 'denyIPs');
            } else if (event.data.type === 'unallowIPs') {
                self.setIPsUnallowed((event.data.data && event.data.data.items) || []);
            } else if (event.data.type === 'allowIPs') {
                self.setIPsAllowed((event.data.data && event.data.data.items) || []);
            } else if (event.data.type === 'allowIP' || event.data.type === 'unallowIP') {
                self.setIPAllowed(event.data.data && event.data.data.ip, event.data.data && event.data.data.filter,
                                  event.data.type === 'allowIP');
            }
        }, false);
    },

    // Send the current connections data to the map iframe
    sendConnectionsToMap: function(connections) {
        var iframe = document.querySelector('#geomate-map-container iframe');
        connections = this.withGeoOverrides(connections);
        if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage({ type: 'updateConnections', data: connections }, '*');
        }   // (no iframe: the tab was left while the data was on its way; nothing to update)
    },

    // Send the allowed IPs data to the map iframe
    sendAllowedIPsToMap: function(allowedIPs) {
        var iframe = document.querySelector('#geomate-map-container iframe');
        if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage({ type: 'updateAllowedIPs', data: allowedIPs }, '*');
        }
    },

    // Load Geo-Filter configurations from UCI and send them to the map
    loadGeoFilters: function() {
        console.log('Loading geo filters');
        return uci.load('geomate').then(() => {
            this.geoFilters = {};
            var sections = uci.sections('geomate', 'geo_filter');
            sections.forEach(section => {
                if (section.name) {
                    this.geoFilters[section.name] = section;
                    var regions = section.allowed_region;
                    if (regions) {
                        if (!Array.isArray(regions)) {
                            regions = [regions];
                        }
                        regions.filter((r, i) => regions.indexOf(r) === i).forEach(region => {   // each shape once
                            if (section.enabled == '1') {
                                this.sendMessageToMap('addRegion', { name: section.name, data: region });
                            }
                        });
                    }
                }
            });
            console.log('Loaded geo filters:', this.geoFilters);
        });
    },

    // Update or add a Geo-Filter based on received data
    updateGeoFilter: function(name, oldRegion, newRegion, isNewRegion, presetId) {
        var self = this;
    
        if (isNewRegion) {
            // Get existing filter settings if available
            var existingSettings = null;
            var sections = uci.sections('geomate', 'geo_filter');
            var existingSection = sections.find(section => section.name === name);
            
            if (existingSection) {
                existingSettings = {
                    protocol: existingSection.protocol,
                    src_ip: srcIpText(existingSection.src_ip),
                    src_port: existingSection.src_port || '',
                    dest_port: existingSection.dest_port || '',
                    allowed_ip: existingSection.allowed_ip || [],
                    ip_list: existingSection.ip_list || ''
                };
            }

            // A chosen preset fills in the protocol and ports (a filter that already exists keeps its own settings)
            var preset = (!existingSection && presetId) ? GEO_PRESETS.find(function(p) { return p.id === presetId; }) : null;
            var seed = existingSettings || (preset ? {
                protocol: preset.protocol, src_ip: '', src_port: preset.src_port || '', dest_port: preset.dest_port || '',
                allowed_ip: [], ip_list: preset.ip_list || ''
            } : null);

            // Modal Dialog for new filters
            var dynlist = new ui.DynamicList('', null, {
                name: 'allowed_ip',
                datatype: 'list(neg(ip4addr))',
                placeholder: _('192.168.1.0/24 or !192.168.1.128/25')
            });

            ui.showModal(_('GeoFilter Settings'), [
                E('div', { 'class': 'cbi-map' }, [
                    E('div', { 'class': 'cbi-section' }, [
                        E('div', { 'class': 'cbi-section-node' }, [
                            // Name (read-only)
                            E('div', { 'class': 'cbi-value' }, [
                                E('label', { 'class': 'cbi-value-title', 'style': 'width:33%' }, _('Name')),
                                E('div', { 'class': 'cbi-value-field', 'style': 'margin-left:33%' }, [
                                    E('input', { 
                                        'type': 'text',
                                        'class': 'cbi-input-text',
                                        'readonly': true,
                                        'value': name
                                    })
                                ])
                            ]),
                            // Preset in use
                            preset ? E('div', { 'class': 'cbi-value' }, [
                                E('label', { 'class': 'cbi-value-title', 'style': 'width:33%' }, _('Preset')),
                                E('div', { 'class': 'cbi-value-field', 'style': 'margin-left:33%' }, [
                                    E('strong', {}, preset.label),
                                    E('div', { 'style': 'margin-top:4px;' }, (preset.allPlatforms ? '\u2714 ' : '') + geoPresetText(preset)),
                                    preset.note ? E('div', { 'style': 'opacity:.75;font-size:90%;margin-top:2px;' }, preset.note) : '',
                                    preset.ip_list ? E('div', { 'style': 'opacity:.75;font-size:90%;margin-top:2px;' }, _('IP list: ') + preset.ip_list) : ''
                                ])
                            ]) : '',
                            // Protocol
                            E('div', { 'class': 'cbi-value' }, [
                                E('label', { 'class': 'cbi-value-title', 'style': 'width:33%' }, _('Protocol')),
                                E('div', { 'class': 'cbi-value-field', 'style': 'margin-left:33%' }, [
                                    E('select', { 
                                        'id': 'geomate-protocol',
                                        'class': 'cbi-input-select'
                                    }, [
                                        E('option', { 
                                            'value': 'tcp',
                                            'selected': (seed && seed.protocol === 'tcp') ? 'selected' : null 
                                        }, 'TCP'),
                                        E('option', { 
                                            'value': 'udp',
                                            'selected': (!seed || seed.protocol === 'udp') ? 'selected' : null
                                        }, 'UDP')
                                    ])
                                ])
                            ]),
                            // Source IP
                            E('div', { 'class': 'cbi-value' }, [
                                E('label', { 'class': 'cbi-value-title', 'style': 'width:33%' }, _('Source IP')),
                                E('div', { 'class': 'cbi-value-field', 'style': 'margin-left:33%' }, [
                                    new ui.Textfield(seed ? seed.src_ip : '', {
                                        id: 'geomate-src-ip',
                                        name: 'src_ip',
                                        placeholder: (preset && preset.needsSrcIp) ? _('your console, e.g. 192.168.1.50 (several: separate with spaces)') : '192.168.1.50 192.168.1.60 or 192.168.1.0/24',
                                        datatype: 'list(neg(ip4addr))',
                                        validate: function(value) { return srcIpCheck(value); },
                                        optional: !(preset && preset.needsSrcIp)
                                    }).render(),
                                    E('select', {
                                        'id': 'geomate-src-device',
                                        'class': 'cbi-input-select',
                                        'style': 'display:none;margin-top:6px;max-width:100%',
                                        'change': function(ev) {
                                            var inp = document.querySelector('input[name="src_ip"]');
                                            if (inp && ev.target.value) {
                                                // adds the device to the ones already there (several devices can share a filter)
                                                var cur = srcIpList(inp.value);
                                                if (cur.indexOf(ev.target.value) === -1) cur.push(ev.target.value);
                                                inp.value = cur.join(' ');
                                                ev.target.value = '';
                                                inp.dispatchEvent(new Event('input', { bubbles: true }));
                                                inp.dispatchEvent(new Event('blur', { bubbles: true }));
                                            }
                                            var w = document.getElementById('geomate-src-warn'); if (w) w.style.display = 'none';
                                        }
                                    }),
                                    (preset && preset.needsSrcIp) ? E('div', {
                                        'id': 'geomate-src-hint',
                                        'style': 'font-size:90%;opacity:.8;margin-top:4px;'
                                    }, _('Needed for this preset: the address of the console or PC you play on. Otherwise every device in the house would be filtered (video calls, VPNs, ...).')) : '',
                                    E('div', {
                                        'id': 'geomate-src-warn',
                                        'style': 'display:none;color:#ef4444;font-weight:600;margin-top:4px;'
                                    }, _('Enter the address of the device you play on first.'))
                                ])
                            ]),
                            // Source Port
                            E('div', { 'class': 'cbi-value' }, [
                                E('label', { 'class': 'cbi-value-title', 'style': 'width:33%' }, _('Source Port')),
                                E('div', { 'class': 'cbi-value-field', 'style': 'margin-left:33%' }, [
                                    new ui.Textfield(seed ? seed.src_port : '', {
                                        id: 'geomate-src-port',
                                        name: 'src_port',
                                        placeholder: '25200 25300 or 27015-27020',
                                        datatype: 'list(neg(portrange))',
                                        optional: true
                                    }).render()
                                ])
                            ]),
                            // Destination Port
                            E('div', { 'class': 'cbi-value' }, [
                                E('label', { 'class': 'cbi-value-title', 'style': 'width:33%' }, _('Destination Port')),
                                E('div', { 'class': 'cbi-value-field', 'style': 'margin-left:33%' }, [
                                    new ui.Textfield(seed ? seed.dest_port : '', {
                                        id: 'geomate-dest-port',
                                        name: 'dest_port',
                                        placeholder: '25200 25300 or 27015-27020',
                                        datatype: 'list(neg(portrange))',
                                        optional: true
                                    }).render()
                                ])
                            ]),
                            // Allowed IPs
                            E('div', { 'class': 'cbi-value' }, [
                                E('label', { 'class': 'cbi-value-title', 'style': 'width:33%' }, _('Allowed IPs')),
                                E('div', { 'class': 'cbi-value-field', 'style': 'margin-left:33%' }, [
                                    dynlist.render()
                                ])
                            ]),
                            // IP List File
                            E('div', { 'class': 'cbi-value' }, [
                                E('label', { 'class': 'cbi-value-title', 'style': 'width:33%' }, _('IP List File')),
                                E('div', { 'class': 'cbi-value-field', 'style': 'margin-left:33%' }, [
                                    E('input', { 
                                        'id': 'geomate-ip-list',
                                        'type': 'text',
                                        'class': 'cbi-input-text',
                                        'readonly': true,
                                        'value': seed ? seed.ip_list : '',
                                        'style': 'margin-bottom: 8px; width: 100%'
                                    }),
                                    E('div', { 'class': 'cbi-value-field-buttons' }, [
                                        E('button', {
                                            'class': 'btn cbi-button-neutral',
                                            'click': function() {
                                                var filename = name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_servers.txt';
                                                var filepath = '/etc/geomate.d/' + filename;
                                                
                                                fs.write(filepath, '').then(function() {
                                                    document.getElementById('geomate-ip-list').value = filepath;
                                                }).catch(function(error) {
                                                    ui.addNotification(null, E('p', {}, _('Failed to create empty file: ' + error.message)));
                                                });
                                            }
                                        }, _('Create Empty List')),
                                        ' ',
                                        E('div', { 'class': 'cbi-value-field', 'style': 'display: inline-block' }, [
                                            E('input', {
                                                'type': 'file',
                                                'id': 'geomate-ip-list-upload',
                                                'style': 'display: none',
                                                'change': function(ev) {
                                                    var file = ev.target.files[0];
                                                    if (!file) return;

                                                    var filename = name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_servers.txt';
                                                    var filepath = '/etc/geomate.d/' + filename;

                                                    var reader = new FileReader();
                                                    reader.onload = function(e) {
                                                        fs.write(filepath, e.target.result).then(function() {
                                                            var ipListInput = document.getElementById('geomate-ip-list');
                                                            if (ipListInput) {
                                                                ipListInput.value = filepath;
                                                            }
                                                        }).catch(function(error) {
                                                            ui.addNotification(null, E('p', {}, _('Failed to upload file: ' + error.message)));
                                                        });
                                                    };
                                                    reader.readAsText(file);
                                                }
                                            }),
                                            E('button', {
                                                'class': 'btn cbi-button-action',
                                                'click': function() {
                                                    document.getElementById('geomate-ip-list-upload').click();
                                                }
                                            }, _('Upload IP List'))
                                        ])
                                    ])
                                ])
                            ])
                        ])
                    ])
                ]),
                E('div', { 'class': 'right' }, [
                    E('button', {
                        'class': 'btn cbi-button-neutral',
                        'click': ui.hideModal
                    }, _('Cancel')),
                    ' ',
                    E('button', {
                        'class': 'btn cbi-button-positive',
                        'click': function() {
                            var srcIpVal = (document.querySelector('input[name="src_ip"]') || {}).value || '';
                            if (srcIpCheck(srcIpVal) !== true) {
                                var srcIn2 = document.querySelector('input[name="src_ip"]');
                                if (srcIn2) srcIn2.focus();
                                return;
                            }
                            if (preset && preset.needsSrcIp && !srcIpVal.trim()) {
                                var warn = document.getElementById('geomate-src-warn');
                                if (warn) warn.style.display = '';
                                var srcIn = document.querySelector('input[name="src_ip"]');
                                if (srcIn) srcIn.focus();
                                return;
                            }
                            var settings = {
                                protocol: document.getElementById('geomate-protocol').value,
                                src_ip: srcIpForRouter(document.querySelector('input[name="src_ip"]').value),
                                src_port: document.querySelector('input[name="src_port"]').value,
                                dest_port: document.querySelector('input[name="dest_port"]').value,
                                allowed_ip: dynlist.getValue(),
                                ip_list: document.getElementById('geomate-ip-list').value
                            };
    
                            ui.hideModal();
                            // A preset's server list file must exist: create it empty if it is missing (an existing file is left alone)
                            var listReady = (preset && preset.ip_list && settings.ip_list === preset.ip_list)
                                ? fs.stat(preset.ip_list).catch(function() { return fs.write(preset.ip_list, ''); }).catch(function() {})
                                : Promise.resolve();
                            listReady.then(function() {
                                if (!(preset && preset.seedFromOthers && settings.ip_list)) return;
                                return self.seedFilterData(name, settings.ip_list).then(function(r) {
                                    if (r) ui.addNotification(null, E('p', {}, _('"%s" starts with the %d servers your other filters already learned (%d with a location). Click Save & Apply.').format(name, r.ips, r.located)), 'info');
                                }).catch(function(err) { console.warn('Could not copy the learned servers:', err); });
                            }).then(function() { self.saveGeoFilter(name, newRegion, settings); });
                        }
                    }, _('Save'))
                ])
            ]);

            // The devices the router knows (DHCP leases), to pick the Source IP from
            L.resolveDefault(callDHCPLeases(), {}).then(function(res) {
                var sel = document.getElementById('geomate-src-device');
                var leases = (res && res.dhcp_leases) || [];
                if (!sel || !leases.length) return;
                var seenIp = {};
                leases = leases.filter(function(l) { return l && l.ipaddr && !seenIp[l.ipaddr] && (seenIp[l.ipaddr] = true); });
                leases.sort(function(a, b) { return String(a.hostname || '~').localeCompare(String(b.hostname || '~')); });
                sel.appendChild(E('option', { 'value': '' }, _('Add a device…')));
                leases.forEach(function(l) {
                    sel.appendChild(E('option', { 'value': l.ipaddr }, (l.hostname ? l.hostname + ' – ' : '') + l.ipaddr + (l.macaddr ? ' (' + l.macaddr + ')' : '')));
                });
                sel.style.display = '';
            });

            // Set DynamicList values after modal is rendered
            requestAnimationFrame(function() {
                if (existingSettings && existingSettings.allowed_ip) {
                    if (!Array.isArray(existingSettings.allowed_ip)) {
                        existingSettings.allowed_ip = [existingSettings.allowed_ip];
                    }
                    dynlist.setValue(existingSettings.allowed_ip);
                }
            });
        } else {
            // Logic for updating existing regions
            return uci.load('geomate')
                .then(() => {
                    var sections = uci.sections('geomate', 'geo_filter');
                    var existingSection = sections.find(section => section.name === name);
                    
                    if (existingSection) {
                        var regions = uci.get('geomate', existingSection['.name'], 'allowed_region') || [];
                        if (!Array.isArray(regions)) {
                            regions = [regions];
                        }

                        // Find and replace the old region
                        var index = regions.indexOf(oldRegion);
                        if (index > -1) {
                            regions[index] = newRegion;
                            // Drop any other copy of the old position (and repeats of the new one), so the old spot doesn't come back
                            regions = regions.filter(function(r, i) {
                                return i === index || (r !== oldRegion && r !== newRegion);
                            });
                            uci.set('geomate', existingSection['.name'], 'allowed_region', regions);
                            return uci.save().then(function() { try { if (ui.changes && ui.changes.init) ui.changes.init(); } catch (e) {} });
                        }
                    }
                });
        }
    },

    // Separate function for moving
    handleMove: function(name, region, newPosition) {
        return this.saveGeoFilter(name, region, null, newPosition);
    },

    // Extended saveGeoFilter function
    saveGeoFilter: function(name, region, settings, newPosition) {
        return uci.load('geomate')
            .then(() => {
                var sections = uci.sections('geomate', 'geo_filter');
                var existingSection = sections.find(section => section.name === name);
                
                if (existingSection && newPosition) {
                    // Only update position
                    var regions = uci.get('geomate', existingSection['.name'], 'allowed_region') || [];
                    if (!Array.isArray(regions)) regions = [regions];
                    
                    // Find and update the region
                    var index = regions.indexOf(region);
                    if (index > -1) {
                        regions.splice(index, 1);
                        regions.splice(newPosition, 0, region);
                        uci.set('geomate', existingSection['.name'], 'allowed_region', regions);
                    }
                } else {
                    // Normal save logic
                    var sectionName;
                    if (existingSection) {
                        sectionName = existingSection['.name'];
                        var regions = uci.get('geomate', sectionName, 'allowed_region') || [];
                        if (!Array.isArray(regions)) regions = [regions];
                        if (!regions.includes(region)) {
                            regions.push(region);
                        }
                        uci.set('geomate', sectionName, 'allowed_region', regions);
                    } else {
                        sectionName = uci.add('geomate', 'geo_filter');
                        uci.set('geomate', sectionName, 'name', name);
                        uci.set('geomate', sectionName, 'allowed_region', [region]);
                    }

                    // Basic settings
                    uci.set('geomate', sectionName, 'enabled', '1');
                    
                    // Optional settings
                    if (settings) {
                        if (settings.protocol) {
                            uci.set('geomate', sectionName, 'protocol', settings.protocol);
                        }
                        if (settings.src_ip) {
                            uci.set('geomate', sectionName, 'src_ip', settings.src_ip);
                        }
                        if (settings.src_port) {
                            uci.set('geomate', sectionName, 'src_port', settings.src_port);
                        }
                        if (settings.dest_port) {
                            uci.set('geomate', sectionName, 'dest_port', settings.dest_port);
                        }
                        if (settings.allowed_ip && settings.allowed_ip.length > 0) {
                            uci.set('geomate', sectionName, 'allowed_ip', settings.allowed_ip);
                        }
                        if (settings.ip_list) {
                            uci.set('geomate', sectionName, 'ip_list', settings.ip_list);
                        }
                    }
                }

                return uci.save();
            });
    },

    // Send a generic message to the map iframe
    // Adds an IP to (allow) or removes it from (deny) the "Allowed IPs" list of a geo filter, and applies the change
    // straight away (no Save & Apply needed). Note: applying activates every change that is waiting, not just this one.
    // The result is reported back to the map.
    setIPAllowed: function(ip, filterName, allow) {
        var self = this;
        function report(ok, message, applied) {
            self.sendMessageToMap('ipActionResult', { data: { ip: ip, action: allow ? 'allow' : 'unallow', ok: ok, message: message, filter: filterName, applied: applied !== false } });
        }
        if (typeof ip !== 'string' || !/^[0-9a-fA-F:.]+(\/[0-9]{1,3})?$/.test(ip)) {
            report(false, 'That does not look like an IP address.');
            return Promise.resolve();
        }
        return uci.load('geomate').then(function() {
            var sections = uci.sections('geomate', 'geo_filter');
            function listOf(sec) {
                var l = sec.allowed_ip || [];
                return Array.isArray(l) ? l.slice() : [l];
            }
            var targets = [];
            if (allow) {
                var sec = sections.find(function(x) { return x.name === filterName; }) || sections[0];
                if (sec) targets.push(sec);
            } else {
                // remove it from every filter that lists it
                targets = sections.filter(function(x) { return listOf(x).indexOf(ip) > -1; });
            }
            if (!targets.length) {
                report(false, allow ? 'There is no geo filter to add it to. Draw a region first.' : 'That IP is not on any allowed list.');
                return;
            }
            targets.forEach(function(sec) {
                var list = listOf(sec);
                if (allow) { if (list.indexOf(ip) === -1) list.push(ip); }
                else list = list.filter(function(x) { return x !== ip; });
                if (list.length) uci.set('geomate', sec['.name'], 'allowed_ip', list);
                else uci.unset('geomate', sec['.name'], 'allowed_ip');
            });
            var usedName = targets[0].name || filterName || '';
            function refreshChanges() { try { if (ui.changes && ui.changes.init) ui.changes.init(); } catch (e) {} }
            return uci.save().then(function() {
                // Apply it right away, the same way Save & Apply does
                return uci.apply(10).then(function() {
                    uci.unload('geomate'); geomateAllowedAt = 0;   // (allowed list changed: fetch it at the next refresh)
                    refreshChanges();
                    report(true, allow ? 'Allowed ' + ip + ' (filter "' + usedName + '"). It is active now.'
                                       : 'Removed ' + ip + ' from the allowed list. It is active now.', true);
                }, function(err) {
                    // Saved, but the automatic apply did not go through: the normal Save & Apply still works
                    console.warn('Automatic apply failed:', err);
                    refreshChanges();
                    report(true, (allow ? 'Added ' + ip : 'Removed ' + ip) + ', but it could not be applied automatically. Click Save & Apply.', false);
                });
            });
        }).catch(function(err) {
            console.error('Could not update the allowed IPs:', err);
            report(false, 'Could not save the change: ' + (err && err.message ? err.message : err));
        });
    },

    // Adds several IPs to the "Allowed IPs" lists at once (each to its own filter), then applies once.
    // Each address gets its own (quiet) result for the map, plus one summary line.
    setIPsAllowed: function(items) {
        var self = this;
        var valid = (items || []).filter(function(it) {
            return it && typeof it.ip === 'string' && /^[0-9a-fA-F:.]+(\/[0-9]{1,3})?$/.test(it.ip);
        });
        function each(ok, applied) {
            valid.forEach(function(it) {
                self.sendMessageToMap('ipActionResult', { data: { ip: it.ip, action: 'allow', ok: ok, applied: applied, quiet: true, filter: it.filter } });
            });
        }
        function summary(msg) { self.sendMessageToMap('ipBatchResult', { data: { message: msg } }); }
        if (!valid.length) { summary('Nothing to allow.'); return Promise.resolve(); }
        return uci.load('geomate').then(function() {
            var sections = uci.sections('geomate', 'geo_filter');
            if (!sections.length) { each(false, false); summary('There is no geo filter to add them to. Draw a region first.'); return; }
            var lists = {};   // section id -> allowed_ip list
            var added = 0;
            valid.forEach(function(it) {
                var sec = sections.find(function(x) { return x.name === it.filter; }) || sections[0];
                var id = sec['.name'];
                if (!lists[id]) { var l = sec.allowed_ip || []; lists[id] = Array.isArray(l) ? l.slice() : [l]; }
                if (lists[id].indexOf(it.ip) === -1) { lists[id].push(it.ip); added++; }
            });
            Object.keys(lists).forEach(function(id) { uci.set('geomate', id, 'allowed_ip', lists[id]); });
            function refreshChanges() { try { if (ui.changes && ui.changes.init) ui.changes.init(); } catch (e) {} }
            var n = valid.length + ' address' + (valid.length === 1 ? '' : 'es');
            return uci.save().then(function() {
                return uci.apply(10).then(function() {
                    uci.unload('geomate'); geomateAllowedAt = 0;   // (allowed list changed: fetch it at the next refresh)
                    refreshChanges();
                    each(true, true);
                    summary('Allowed ' + n + '. Active now.');
                }, function(err) {
                    console.warn('Automatic apply failed:', err);
                    refreshChanges();
                    each(true, false);
                    summary('Added ' + n + ', but it could not be applied automatically. Click Save & Apply.');
                });
            });
        }).catch(function(err) {
            console.error('Could not update the allowed IPs:', err);
            each(false, false);
            summary('Could not save the change: ' + (err && err.message ? err.message : err));
        });
    },

    // ----- corrected server locations -----
    // The router locates servers with ip-api.com, which sometimes puts a game server in the wrong city. A location
    // corrected on the map is saved in GEO_OVERRIDES_FILE and written into every filter's location data that has the
    // address (the original is kept beside it, for Undo). Geomate is then restarted, because it builds its allowed and
    // blocked lists from those files when it starts.
    geoOverrides: {},

    loadGeoOverrides: function() {
        var self = this;
        return L.resolveDefault(fs.read(GEO_OVERRIDES_FILE), '').then(function(txt) {
            var o = null;
            try { o = JSON.parse(txt || '{}'); } catch (e) { o = null; }
            self.geoOverrides = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
            return self.geoOverrides;
        });
    },

    sendGeoOverridesToMap: function() {
        var ov = this.geoOverrides || {}, out = {};
        Object.keys(ov).forEach(function(ip) { out[ip] = { lat: ov[ip].lat, lon: ov[ip].lon }; });
        this.sendMessageToMap('geoOverrides', { data: out });
    },

    // The connections as the map should show them: a corrected address at its corrected place
    withGeoOverrides: function(connections) {
        var ov = this.geoOverrides || {};
        if (!connections || !Object.keys(ov).length) return connections;
        return connections.map(function(c) {
            var o = c && c.dst && ov[c.dst];
            if (!o || typeof o.lat !== 'number' || typeof o.lon !== 'number') return c;
            var copy = Object.assign({}, c);
            copy.geo = Object.assign({}, c.geo || {}, { lat: o.lat, lon: o.lon });
            if (o.city) copy.geo.city = o.city;
            if (o.region) copy.geo.regionName = o.region;
            if (o.country || o.countryCode) copy.geo.country = o.country || o.countryCode;
            copy.geo_override = true;
            return copy;
        });
    },

    // Writes corrections into one filter's location data, in one pass.
    // changes: ip -> correction, or null to go back to the router's own location. append: ips to add when missing.
    patchGeoData: function(name, changes, append) {
        var path = '/etc/geomate.d/' + name + '_geo_data.json';
        var KEEP = [ 'lat', 'lon', 'city', 'region', 'regionName', 'country', 'countryCode' ];
        return L.resolveDefault(fs.read(path), null).then(function(txt) {
            if (txt == null && !Object.keys(append || {}).length) return false;
            var lines = txt ? txt.split('\n') : [];
            if (lines.length && lines[lines.length - 1] === '') lines.pop();
            var seen = {}, changed = false, out = [];
            lines.forEach(function(line) {
                var m = /"query":"([^"]+)"/.exec(line);
                var ip = m && m[1];
                if (!ip || !Object.prototype.hasOwnProperty.call(changes, ip)) { out.push(line); return; }
                var d;
                try { d = JSON.parse(line); } catch (e) { out.push(line); return; }
                if (!d || d.query !== ip) { out.push(line); return; }
                seen[ip] = true;
                var ov = changes[ip];
                if (ov) {
                    var same = d.geomate_override && d.lat === ov.lat && d.lon === ov.lon;
                    if (same) { out.push(line); return; }
                    if (!d.geomate_override) {
                        var orig = {};
                        KEEP.forEach(function(k) { if (d[k] !== undefined) orig[k] = d[k]; });
                        d.geomate_router = orig;
                    }
                    d.lat = ov.lat; d.lon = ov.lon;
                    if (ov.city) d.city = ov.city;
                    if (ov.region) d.regionName = ov.region;
                    if (ov.country) d.country = ov.country;
                    if (ov.countryCode) d.countryCode = ov.countryCode;
                    d.geomate_override = true;
                    out.push(JSON.stringify(d));
                    changed = true;
                } else {
                    if (!d.geomate_override) { out.push(line); return; }
                    changed = true;
                    if (d.geomate_added) return;   // the correction had added this entry: take it out again
                    var r = d.geomate_router || {};
                    KEEP.forEach(function(k) {
                        if (Object.prototype.hasOwnProperty.call(r, k)) d[k] = r[k];
                        else if (k !== 'lat' && k !== 'lon') delete d[k];   // a name only the correction had added
                    });
                    delete d.geomate_router; delete d.geomate_override;
                    out.push(JSON.stringify(d));
                }
            });
            Object.keys(append || {}).forEach(function(ip) {
                var ov = changes[ip];
                if (seen[ip] || !ov) return;
                out.push(JSON.stringify({ status: 'success', query: ip, lat: ov.lat, lon: ov.lon, city: ov.city || '', regionName: ov.region || '',
                                          country: ov.country || '', countryCode: ov.countryCode || '', geomate_override: true, geomate_added: true }));
                changed = true;
            });
            if (!changed) return false;
            return fs.write(path, out.length ? out.join('\n') + '\n' : '').then(function() { return true; });
        });
    },

    // Writes the given corrections into every filter's location data; restarts Geomate when something changed.
    // Resolves to 'unchanged', 'restarted' or 'norestart'.
    writeGeoOverrides: function(changes, appendTo) {
        var self = this;
        return uci.load('geomate').then(function() {
            var names = uci.sections('geomate', 'geo_filter').map(function(s) { return s.name; })
                .filter(function(n, i, a) { return n && a.indexOf(n) === i && n.indexOf('/') === -1; });
            // one file after the other (each is read and written whole)
            return names.reduce(function(p, n) {
                return p.then(function(any) {
                    var append = {};
                    Object.keys(appendTo || {}).forEach(function(ip) { if (appendTo[ip] === n) append[ip] = true; });
                    return self.patchGeoData(n, changes, append).then(function(ch) { return any || ch; });
                });
            }, Promise.resolve(false));
        }).then(function(changed) {
            if (!changed) return 'unchanged';
            return fs.exec('/etc/init.d/geomate', [ 'restart' ]).then(function() { return 'restarted'; }, function(err) {
                console.warn('Geomate restart after a location correction:', err);
                return (err && err.name === 'PermissionError') ? 'norestart' : 'restarted';   // (a slow restart times out but still happens)
            });
        });
    },

    setGeoOverride: function(d, clear) {
        var self = this;
        var ip = d && d.ip;
        var lat = +d.lat, lon = +d.lon;
        function report(ok, message, extra) {
            self.sendMessageToMap('geoOverrideResult', { data: Object.assign({ ip: ip, ok: ok, cleared: !!clear, message: message }, extra || {}) });
        }
        if (typeof ip !== 'string' || !/^[0-9a-fA-F:.]+$/.test(ip)) { report(false, 'That does not look like an IP address.'); return Promise.resolve(); }
        if (!clear && (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)) { report(false, 'That is not a valid location.'); return Promise.resolve(); }
        var ov = clear ? null : {
            lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5,
            city: String(d.city || '').slice(0, 80), region: String(d.region || '').slice(0, 80),
            country: String(d.country || '').slice(0, 80), countryCode: String(d.countryCode || '').slice(0, 3),
            source: String(d.source || '').slice(0, 30), filter: String(d.filter || ''), set: new Date().toISOString()
        };
        var label = ov ? ([ ov.city, ov.region, ov.country || ov.countryCode ].filter(Boolean).filter(function(x, i, a) { return a.indexOf(x) === i; }).join(', ') ||
                          ov.lat.toFixed(2) + ', ' + ov.lon.toFixed(2)) : '';
        var changes = {}; changes[ip] = ov;
        var appendTo = {}; if (ov && ov.filter) appendTo[ip] = ov.filter;
        return self.loadGeoOverrides().then(function(all) {
            if (clear) delete all[ip]; else all[ip] = ov;
            return fs.write(GEO_OVERRIDES_FILE, JSON.stringify(all, null, 1) + '\n').then(function() { self.geoOverrides = all; });
        }).then(function() {
            self.sendGeoOverridesToMap();
            self.sendConnectionsToMap(self.currentConnectionsData || []);
            return self.writeGeoOverrides(changes, appendTo);
        }).then(function(result) {
            var extra = ov ? { lat: ov.lat, lon: ov.lon, place: label, country: ov.country } : {};
            var tail = result === 'norestart' ? ' Restart Geomate (or the router) so the filter uses it.' : ' The filter uses it now.';
            if (clear) report(true, 'Back to the router’s own location for ' + ip + '.' + (result === 'norestart' ? tail : ''), extra);
            else report(true, 'Saved: ' + ip + ' is in ' + label + '.' + tail, extra);
        }).catch(function(err) {
            console.error('Could not save the location correction:', err);
            report(false, 'Could not save the location: ' + (err && err.message ? err.message : err));
        });
    },

    // Geomate only adds the servers a filter sees to its list every 30 minutes and looks up where they are after that.
    // Until then a new server is "not located yet": with Strict Mode it is blocked (even if it is inside your region),
    // and it has no place on the map. So the page asks the router's own lookup (geolocate.sh, the same ip-api.com lookup
    // Geomate uses) for those servers right away. The script saves the locations and restarts Geomate when it found
    // any, which sorts the servers into allowed / blocked within seconds. Requests are gathered for a few seconds and
    // made at most every 30 s; an address is asked for again only after 5 minutes.
    locatePendingSoon: function(connections) {
        var self = this, now = Date.now();
        var byFilter = {};
        (connections || []).forEach(function(c) {
            if (!c || !c.pending || !c.filter_name || typeof c.dst !== 'string') return;
            if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(c.dst) || c.filter_name.indexOf('/') > -1) return;
            if (geomateLocateAsked[c.dst] && now - geomateLocateAsked[c.dst] < 5 * 60000) return;
            (byFilter[c.filter_name] = byFilter[c.filter_name] || []).push(c.dst);
        });
        var names = Object.keys(byFilter);
        if (!names.length) return;
        self._locateQueue = self._locateQueue || {};
        names.forEach(function(n) {
            var q = self._locateQueue[n] = self._locateQueue[n] || [];
            byFilter[n].forEach(function(ip) { if (q.indexOf(ip) === -1) q.push(ip); });
        });
        if (geomateLocateTimer) return;
        var wait = Math.max(4000, 30000 - (now - geomateLocateLast));
        geomateLocateTimer = setTimeout(function() { geomateLocateTimer = null; self.locatePendingNow(); }, wait);
    },

    locatePendingNow: function() {
        var self = this;
        if (geomateLocateBusy) { geomateLocateTimer = setTimeout(function() { geomateLocateTimer = null; self.locatePendingNow(); }, 5000); return; }
        var queue = self._locateQueue || {};
        self._locateQueue = {};
        var jobs = Object.keys(queue).map(function(n) { return { name: n, ips: queue[n].slice(0, 90) }; }).filter(function(j) { return j.ips.length; });
        if (!jobs.length) return;
        geomateLocateBusy = true;
        geomateLocateLast = Date.now();
        jobs.forEach(function(j) { j.ips.forEach(function(ip) { geomateLocateAsked[ip] = Date.now(); }); });
        var total = jobs.reduce(function(a, j) { return a + j.ips.length; }, 0);
        self.sendMessageToMap('locatingIPs', { data: { ips: [].concat.apply([], jobs.map(function(j) { return j.ips; })) } });
        console.log('Asking the router to locate ' + total + ' new server(s) now:', jobs);
        // one filter after the other: the script restarts Geomate at the end of each run that found something
        jobs.reduce(function(p, j) {
            return p.then(function() {
                return fs.exec('/etc/geolocate.sh', [ 'specific', j.name ].concat(j.ips)).catch(function(err) {
                    console.warn('Locating new servers for "' + j.name + '":', err);   // (a long run can time out here but still finishes)
                });
            });
        }, Promise.resolve()).then(function() {
            geomateLocateBusy = false;
            geomateLiveSkipUntil = 0;
            setTimeout(function() { if (self.pollLive) self.pollLive(); }, 1500);
        });
    },

    // A filter's name becomes part of the router's firewall set names (geomate_<name>_allowed, ...), which allow only
    // letters, numbers and _ . - (spaces become _). A name with anything else, e.g. "Any game (all ports)" (the first
    // name of the Any Game preset), makes Geomate fail to set the filter up, so it filters nothing. Such a filter is
    // renamed once (its location data file goes with it) and the change is applied.
    fixInvalidFilterNames: function() {
        var self = this;
        if (self._namesChecked) return Promise.resolve();
        self._namesChecked = true;
        var OK = /^[A-Za-z0-9_ .-]+$/;
        return uci.load('geomate').then(function() {
            var sections = uci.sections('geomate', 'geo_filter');
            var used = {};
            sections.forEach(function(s) { if (s.name) used[s.name] = true; });
            var renames = [];
            var srcFixes = [];
            sections.forEach(function(s) {
                // several source addresses written with spaces only ("a b"): the router needs "{ a, b }"
                if (s.src_ip != null && srcIpCheck(s.src_ip) === true) {
                    var want = srcIpForRouter(s.src_ip);
                    var have = Array.isArray(s.src_ip) ? s.src_ip.join(' ') : String(s.src_ip);
                    if (want && want !== have && srcIpList(s.src_ip).length > 1) srcFixes.push({ id: s['.name'], name: s.name, value: want });
                }
                if (!s.name || OK.test(s.name)) return;
                var base = s.name.replace(/[^A-Za-z0-9_ .-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Filter';
                var nn = base, i = 2;
                while (used[nn]) nn = base + ' ' + (i++);
                used[nn] = true;
                renames.push({ id: s['.name'], from: s.name, to: nn });
            });
            if (!renames.length && !srcFixes.length) return;
            srcFixes.forEach(function(f) { uci.set('geomate', f.id, 'src_ip', f.value); });
            return renames.reduce(function(p, r) {
                return p.then(function() {
                    var from = '/etc/geomate.d/' + r.from + '_geo_data.json', to = '/etc/geomate.d/' + r.to + '_geo_data.json';
                    return (r.from.indexOf('/') > -1 ? Promise.resolve(null) : L.resolveDefault(fs.read(from), null)).then(function(txt) {
                        if (txt == null || !txt.trim()) return;
                        return L.resolveDefault(fs.read(to), '').then(function(cur) {
                            if (cur && cur.trim()) return;   // the new name has data already: keep it
                            return fs.write(to, txt).then(function() { return L.resolveDefault(fs.remove(from), null); });
                        });
                    });
                });
            }, Promise.resolve()).then(function() {
                renames.forEach(function(r) { uci.set('geomate', r.id, 'name', r.to); });
                return uci.save();
            }).then(function() {
                return uci.apply(10).then(function() { uci.unload('geomate'); }, function(err) { console.warn('Applying the renamed filters:', err); });
            }).then(function() {
                try { if (ui.changes && ui.changes.init) ui.changes.init(); } catch (e) {}
                srcFixes.forEach(function(f) {
                    ui.addNotification(null, E('p', {}, _('The source devices of "%s" were rewritten as %s, the form the router needs for several devices.').format(f.name, f.value)), 'info');
                });
                renames.forEach(function(r) {
                    ui.addNotification(null, E('p', {}, _('The filter "%s" was renamed to "%s": the router cannot use brackets or other special characters in a filter name, so it was not filtering until now.').format(r.from, r.to)), 'info');
                });
                // redraw the regions under their new names
                self.sendMessageToMap('clearMap', {});
                return self.loadGeoFilters().then(function() {
                    self.sendConnectionsToMap(self.currentConnectionsData || []);
                    self.sendAllowedIPsToMap(self.allowedIPsData || []);
                }).catch(function() {});
            });
        }).catch(function(err) { console.warn('Could not check the filter names:', err); });
    },

    // A new filter starts with an empty server list, and Geomate only adds the servers it sees to the list every 30
    // minutes (then looks up where they are). Until then the filter has nothing to go by: everything passes, or with
    // Strict Mode everything is blocked. So an "Any game" filter starts with every server the other filters have already
    // learned, and their locations. Only done while the filter's own list is still empty. Resolves to the counts or null.
    seedFilterData: function(name, ipListPath) {
        if (!name || !ipListPath || name.indexOf('/') > -1) return Promise.resolve(null);
        var geoPath = '/etc/geomate.d/' + name + '_geo_data.json';
        var ownList = '', ownGeo = '';
        return Promise.all([ L.resolveDefault(fs.read(ipListPath), ''), L.resolveDefault(fs.read(geoPath), '') ]).then(function(own) {
            ownList = own[0] || ''; ownGeo = own[1] || '';
            if (ownList.trim()) return null;   // it has learned servers of its own already
            return uci.load('geomate').then(function() {
                var others = uci.sections('geomate', 'geo_filter').filter(function(s) { return s.name && s.name !== name && s.name.indexOf('/') === -1; });
                var lists = others.map(function(s) { return s.ip_list; })
                    .filter(function(p, i, a) { return p && p !== ipListPath && a.indexOf(p) === i; });
                return Promise.all([
                    Promise.all(lists.map(function(p) { return L.resolveDefault(fs.read(p), ''); })),
                    Promise.all(others.map(function(s) { return L.resolveDefault(fs.read('/etc/geomate.d/' + s.name + '_geo_data.json'), ''); }))
                ]);
            }).then(function(r) {
                var seenIp = {}, ipOut = [];
                r[0].forEach(function(txt) {
                    String(txt || '').split('\n').forEach(function(line) {
                        line = line.trim();
                        var ip = line.split(',')[0].trim();
                        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || seenIp[ip]) return;
                        seenIp[ip] = true; ipOut.push(line);
                    });
                });
                var seenGeo = {}, geoOut = [];
                [ ownGeo ].concat(r[1]).forEach(function(txt) {
                    String(txt || '').split('\n').forEach(function(line) {
                        var m = /"query":"([^"]+)"/.exec(line);
                        if (!m || seenGeo[m[1]]) return;
                        seenGeo[m[1]] = true; geoOut.push(line.trim());
                    });
                });
                if (!ipOut.length) return null;
                return fs.write(geoPath, geoOut.length ? geoOut.join('\n') + '\n' : '').then(function() {
                    return fs.write(ipListPath, ipOut.join('\n') + '\n');   // (the list last: it is what marks the filter as filled)
                }).then(function() { return { ips: ipOut.length, located: geoOut.length }; });
            });
        });
    },

    // Once per page load: fill "Any game" filters that are still empty (e.g. made before this existed), then restart
    // Geomate so it filters by them.
    seedEmptyAnyGameFilters: function() {
        var self = this;
        if (geomateSeedChecked) return Promise.resolve();
        geomateSeedChecked = true;
        var lists = GEO_PRESETS.filter(function(p) { return p.seedFromOthers && p.ip_list; }).map(function(p) { return p.ip_list; });
        return uci.load('geomate').then(function() {
            var targets = uci.sections('geomate', 'geo_filter').filter(function(s) { return s.name && s.enabled == '1' && lists.indexOf(s.ip_list) > -1; });
            return targets.reduce(function(p, s) {
                return p.then(function(done) {
                    return self.seedFilterData(s.name, s.ip_list).then(function(r) { if (r) done.push({ name: s.name, r: r }); return done; });
                });
            }, Promise.resolve([]));
        }).then(function(done) {
            if (!done.length) return;
            done.forEach(function(d) {
                ui.addNotification(null, E('p', {}, _('"%s" now starts with the %d servers your other filters already learned (%d with a location).').format(d.name, d.r.ips, d.r.located)), 'info');
            });
            return fs.exec('/etc/init.d/geomate', [ 'restart' ]).catch(function(err) { console.warn('Geomate restart after filling a filter:', err); });
        }).catch(function(err) { console.warn('Could not fill the empty Any game filters:', err); });
    },

    // Once per page load: the router's daily location refresh rewrites the location data, which drops corrections.
    // Put them back (and restart Geomate) if that happened.
    reapplyGeoOverrides: function() {
        var self = this;
        if (geomateOverridesChecked) { self.sendGeoOverridesToMap(); return Promise.resolve(); }
        geomateOverridesChecked = true;
        return self.loadGeoOverrides().then(function(all) {
            self.sendGeoOverridesToMap();
            self.sendConnectionsToMap(self.currentConnectionsData || []);
            var ips = Object.keys(all);
            if (!ips.length) return;
            var changes = {};
            ips.forEach(function(ip) { changes[ip] = all[ip]; });
            // (only entries the files still have are corrected again; nothing is added back)
            return self.writeGeoOverrides(changes, {}).then(function(r) {
                if (r !== 'unchanged') console.log('Location corrections were put back into the filter data (' + r + ')');
            });
        }).catch(function(err) { console.warn('Could not check the location corrections:', err); });
    },

    // The addresses you blocked (list "denied_ip" of each filter), for the map
    sendDeniedToMap: function() {
        var self = this;
        return uci.load('geomate').then(function() {
            var out = {};
            uci.sections('geomate', 'geo_filter').forEach(function(sec) {
                L.toArray(sec.denied_ip).forEach(function(ip) { out[ip] = sec.name || ''; });
            });
            self.sendMessageToMap('deniedIPs', { data: out });
        }).catch(function() {});
    },

    // Blocks (deny = true) or unblocks addresses. A block goes on the filter's "denied_ip" list, which the router's
    // helper (luci.geomate) turns into a drop rule that comes before everything else, even your regions. A blocked
    // address is also taken off the allowed lists. One change, applied once.
    setIPsDenied: function(items, deny) {
        var self = this;
        var valid = (items || []).filter(function(it, i, a) {
            return it && typeof it.ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(it.ip) &&
                   a.findIndex(function(x) { return x && x.ip === it.ip; }) === i;
        });
        var action = deny ? 'deny' : 'undeny';
        function each(ok, applied, which) {
            which.forEach(function(it) {
                self.sendMessageToMap('ipActionResult', { data: { ip: it.ip, action: action, ok: ok, applied: applied, quiet: valid.length > 1, filter: it.filter,
                    message: valid.length > 1 ? undefined : (ok ? (deny ? 'Blocked ' + it.ip + '.' : 'Unblocked ' + it.ip + '. Your regions decide again.') + (applied ? ' Active in a few seconds.' : ' Click Save & Apply.') : 'Could not change ' + it.ip + '.') } });
            });
        }
        function summary(msg) { if (valid.length > 1) self.sendMessageToMap('ipBatchResult', { data: { message: msg } }); }
        if (!valid.length) { summary('Nothing to change.'); return Promise.resolve(); }
        return uci.load('geomate').then(function() {
            var sections = uci.sections('geomate', 'geo_filter');
            if (!sections.length) { each(false, false, valid); summary('There is no geo filter yet.'); return; }
            var lists = {}, allowLists = {};
            function denied(sec) { if (!lists[sec['.name']]) lists[sec['.name']] = L.toArray(sec.denied_ip).slice(); return lists[sec['.name']]; }
            valid.forEach(function(it) {
                if (deny) {
                    var sec = sections.find(function(x) { return x.name === it.filter; }) || sections[0];
                    var l = denied(sec);
                    if (l.indexOf(it.ip) === -1) l.push(it.ip);
                    // off the allowed lists: blocked means blocked
                    sections.forEach(function(x) {
                        var a = allowLists[x['.name']] || L.toArray(x.allowed_ip).slice();
                        var i = a.indexOf(it.ip);
                        if (i > -1) { a.splice(i, 1); allowLists[x['.name']] = a; }
                    });
                } else {
                    sections.forEach(function(x) {
                        var l = denied(x), i = l.indexOf(it.ip);
                        if (i > -1) l.splice(i, 1);
                    });
                }
            });
            Object.keys(lists).forEach(function(id) {
                if (lists[id].length) uci.set('geomate', id, 'denied_ip', lists[id]); else uci.unset('geomate', id, 'denied_ip');
            });
            Object.keys(allowLists).forEach(function(id) {
                if (allowLists[id].length) uci.set('geomate', id, 'allowed_ip', allowLists[id]); else uci.unset('geomate', id, 'allowed_ip');
            });
            function refreshChanges() { try { if (ui.changes && ui.changes.init) ui.changes.init(); } catch (e) {} }
            var n = valid.length + ' address' + (valid.length === 1 ? '' : 'es');
            return uci.save().then(function() {
                return uci.apply(10).then(function() {
                    uci.unload('geomate'); geomateAllowedAt = 0;   // (allowed list changed: fetch it at the next refresh)
                    refreshChanges();
                    each(true, true, valid);
                    summary((deny ? 'Blocked ' : 'Unblocked ') + n + '. Active in a few seconds.');
                    self.sendDeniedToMap();
                }, function(err) {
                    console.warn('Automatic apply failed:', err);
                    refreshChanges();
                    each(true, false, valid);
                    summary((deny ? 'Blocked ' : 'Unblocked ') + n + ', but it could not be applied automatically. Click Save & Apply.');
                });
            });
        }).catch(function(err) {
            console.error('Could not change the blocked IPs:', err);
            each(false, false, valid);
            summary('Could not save the change: ' + (err && err.message ? err.message : err));
        });
    },

    // Takes several IPs off the "Allowed IPs" lists at once (from every filter that lists them), then applies once.
    setIPsUnallowed: function(items) {
        var self = this;
        var ips = (items || []).map(function(it) { return it && it.ip; }).filter(function(ip, i, a) {
            return typeof ip === 'string' && /^[0-9a-fA-F:.]+(\/[0-9]{1,3})?$/.test(ip) && a.indexOf(ip) === i;
        });
        function each(ok, applied, which) {
            (which || ips).forEach(function(ip) {
                self.sendMessageToMap('ipActionResult', { data: { ip: ip, action: 'unallow', ok: ok, applied: applied, quiet: true } });
            });
        }
        function summary(msg) { self.sendMessageToMap('ipBatchResult', { data: { message: msg } }); }
        if (!ips.length) { summary('Nothing to remove.'); return Promise.resolve(); }
        return uci.load('geomate').then(function() {
            var drop = {};
            ips.forEach(function(ip) { drop[ip] = true; });
            var found = {};
            uci.sections('geomate', 'geo_filter').forEach(function(sec) {
                var l = sec.allowed_ip || [];
                l = Array.isArray(l) ? l.slice() : [ l ];
                var kept = l.filter(function(x) { if (drop[x]) { found[x] = true; return false; } return true; });
                if (kept.length === l.length) return;
                if (kept.length) uci.set('geomate', sec['.name'], 'allowed_ip', kept);
                else uci.unset('geomate', sec['.name'], 'allowed_ip');
            });
            var removed = ips.filter(function(ip) { return found[ip]; });
            var missing = ips.filter(function(ip) { return !found[ip]; });
            if (missing.length) each(false, false, missing);
            if (!removed.length) { summary('None of them was on an allowed list.'); return; }
            function refreshChanges() { try { if (ui.changes && ui.changes.init) ui.changes.init(); } catch (e) {} }
            var n = removed.length + ' address' + (removed.length === 1 ? '' : 'es');
            return uci.save().then(function() {
                return uci.apply(10).then(function() {
                    uci.unload('geomate'); geomateAllowedAt = 0;   // (allowed list changed: fetch it at the next refresh)
                    refreshChanges();
                    each(true, true, removed);
                    summary('Removed ' + n + ' from the allowed list. Active now.');
                }, function(err) {
                    console.warn('Automatic apply failed:', err);
                    refreshChanges();
                    each(true, false, removed);
                    summary('Removed ' + n + ', but it could not be applied automatically. Click Save & Apply.');
                });
            });
        }).catch(function(err) {
            console.error('Could not update the allowed IPs:', err);
            each(false, false);
            summary('Could not save the change: ' + (err && err.message ? err.message : err));
        });
    },

    sendMessageToMap: function(type, data) {
        var iframe = document.querySelector('#geomate-map-container iframe');
        if (iframe) {
            iframe.contentWindow.postMessage({ type: type, ...data }, '*');
        }
    },

    // Check and log the current UCI configuration for Geomate
    checkUCIConfig: function() {
        return uci.load('geomate')
            .then(() => {
                var sections = uci.sections('geomate', 'geo_filter');
                console.log('Current UCI geomate config:', sections);
                return sections;
            });
    },

    // Log the current UCI values for debugging purposes
    logUCIValues: function() {
        return uci.load('geomate')
            .then(() => {
                var sections = uci.sections('geomate', 'geo_filter');
                console.log('Current UCI geomate config:', JSON.stringify(sections, null, 2));
            });
    },

    // Debug function to log any changes in the UCI configuration
    debugUCI: function() {
        return uci.changes()
            .then(changes => {
                console.log('Current UCI changes:', JSON.stringify(changes, null, 2));
            })
            .catch(error => {
                console.error('Error getting UCI changes:', error);
            });
    },

    // Handle the reset action to clear the map and reload geo filters
    handleReset: function(ev) {
        var view = this;
        // Regions are written to the configuration as soon as they are drawn (shown as "Unsaved Changes" until applied),
        // so Reset must discard those staged changes too, otherwise the rules would simply come back.
        return Promise.resolve(callUciRevert('geomate'))
            .catch(function(err) { console.warn('Could not revert staged changes:', err); })
            .then(function() {
                uci.unload('geomate'); geomateAllowedAt = 0;   // (allowed list changed: fetch it at the next refresh)
                return view.map.reset();
            })
            .then(function() {
                // Reset rebuilds the form, so put the presentation back on the new content
                var box = document.getElementById('geomate-map-container');
                var root = box && box.closest ? box.closest('.cbi-map') : null;
                if (root) root.classList.add('geomate-dumaos-theme');
                if (view.hideStatusSection) view.hideStatusSection(root || document);
                if (view.fitMapToWindow) { view.fitMapToWindow(); setTimeout(view.fitMapToWindow, 300); setTimeout(view.fitMapToWindow, 1200); }
                view.sendMessageToMap('clearMap');
                // refresh the "Unsaved Changes" counter in the page header
                try { if (ui.changes && ui.changes.init) ui.changes.init(); } catch (e) {}
                return view.loadGeoFilters();
            })
            .then(function() {
                ui.addNotification(null, E('p', _('Form values have been reset')), 'success');
            });
    },

    // Function to update the active connections table
    updateActiveConnectionsList: function() {
        var tbody = document.getElementById('active-connections-table-body');
        if (!tbody) return;
    
        // Clear the existing table content
        while (tbody.firstChild) {
            tbody.removeChild(tbody.firstChild);
        }
    
        var connections = this.currentConnectionsData;
    
        // Skip any connection object lacking filter_name to avoid errors
        connections.forEach(function(conn) {
            if (!conn || !conn.filter_name) {
                console.warn('Skipping a connection with no filter_name:', conn);
                return;  // Safely skip this item
            }
    
            var geoFilterName = conn.filter_name || _('Unknown');
            var status = _('Unknown');
    
            // Determine the status based on connection data
            if (conn.is_allowed_ip) {
                status = _('Allowed (Whitelist)');
            } else if (conn.pending) {
                // not located yet, so not sorted into the filter's allowed/blocked set (the router says what happens meanwhile)
                status = conn.allowed === false ? _('Blocked (not located yet, Strict Mode)') : _('Allowed (not located yet)');
            } else if (conn.allowed === true) {
                status = _('Allowed');
            } else if ((!conn.geo || !conn.geo.lat || !conn.geo.lon) &&
                       (conn.allowed === false || typeof conn.allowed === 'undefined')) {
                status = _('Untracked');
            } else if (conn.allowed === false) {
                status = _('Blocked');
            } else {
                status = _('Unknown');
            }
    
            var destIP = conn.dst || _('Unknown');
            var tr = E('tr', {}, [
                E('td', {}, destIP),
                E('td', {}, geoFilterName),
                E('td', {}, status)
            ]);
            tbody.appendChild(tr);
        });
    
        console.log('Active connections:', connections);
    },

    // Remove a Geo-Filter or a specific region from it
    deleteGeoFilter: function(name, region) {
        console.log('Removing region from UCI config:', name, region);
        return uci.load('geomate')
            .then(() => {
                var sections = uci.sections('geomate', 'geo_filter');
                var existingSection = sections.find(section => section.name === name);
                if (existingSection) {
                    var regionsList = existingSection.allowed_region || [];
                    if (!Array.isArray(regionsList)) {
                        regionsList = [regionsList];
                    }

                    var index = regionsList.indexOf(region);
                    if (index > -1) {
                        regionsList.splice(index, 1);
                        console.log('Remaining regions after deletion:', regionsList);

                        if (regionsList.length === 0) {
                            // If no regions remain, disable the filter
                            uci.set('geomate', existingSection['.name'], 'enabled', '0');
                            uci.unset('geomate', existingSection['.name'], 'allowed_region');
                            console.log('Disabled filter due to no regions:', name);
                        } else {
                            // Update the regions list
                            uci.set('geomate', existingSection['.name'], 'allowed_region', regionsList);
                        }
                        
                        return uci.save();
                    }
                }
                return Promise.resolve();
            });
    },

    // Check for updates
    checkForUpdates: function() {
        var statusElement = document.getElementById('version-update-status');
        var versionDisplayElement = document.getElementById('version-display');
        
        if (!statusElement) {
            return Promise.resolve();
        }
        
        statusElement.textContent = _('Checking...');
        statusElement.style.color = '#6b7280';

        return fs.exec('/etc/init.d/geomate', ['check_version']).then(function(result) {
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
        });
    }
});
