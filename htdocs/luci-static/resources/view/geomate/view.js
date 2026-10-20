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

function filterColor(index, name) {
    if (index < PALETTE.length)
        return PALETTE[index];
    var hash = 0;
    for (var i = 0; i < name.length; i++)
        hash = (name.charCodeAt(i) + ((hash << 5) - hash)) | 0;
    return PALETTE[Math.abs(hash) % PALETTE.length];
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
// IPs with an active connection
var callGeomateConnections = rpc.declare({
    object: 'luci.geomate',
    method: 'getGeomateConnections',
    expect: { connections: [] },
    reject: true
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
    pendingSeq: 0,      // counts writes of pending by stage() and handleReset(); an older poll reply loses
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
    nodes: null,        // nodes that the polls update in place
    pollFns: null,      // bound poll functions; poll.add() and poll.remove() match them by identity
    connectionsBusy: null,  // running getGeomateConnections request
    statusBusy: null,       // running status request
    versionBusy: null,      // running check_version request

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

        if (!configLoaded)
            ui.addNotification(null, E('p', {}, [
                _('The geomate configuration could not be loaded, so the map cannot show or change regions. Reload the page.')
            ]), 'error');

        var nodes = E([], [ this.renderStatus(), this.renderMap(), this.renderConnections() ]);

        window.addEventListener('message', L.bind(this.handleMessage, this), false);
        this.updateStatus();
        this.startPolls();

        return nodes;
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
        n.pending = E('span', {
            id: 'geomate-pending-changes',
            style: 'display: none; margin-left: 8px; font-weight: bold;',
            title: _('Staged changes take effect only after Save & Apply and are lost on logout or session expiry.')
        });
        n.stale = E('span', {
            id: 'geomate-connections-stale',
            style: 'display: none; color: orange; margin-left: 8px;'
        });
        n.mode = E('p', { id: 'operational-mode-text', style: 'margin: 0;' });
        n.version = E('span', { id: 'version-display', style: 'color: #6b7280;' }, [ _('Loading version...') ]);
        n.update = E('span', { id: 'version-update-status', style: 'margin-left: 8px; font-style: italic;' });

        return E('div', { style: 'display: flex; flex-direction: column; margin-left: 8px;' }, [
            // Service status, health checks, loading, stale connections and pending changes in one row
            E('div', { style: 'display: flex; align-items: center; flex-wrap: wrap; gap: 8px;' }, [
                E('div', { style: 'display: flex; align-items: center;' }, [ n.indicator, n.state ]),
                n.health,
                n.loading,
                n.stale,
                n.pending
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

    renderMap: function() {
        this.nodes.frame = E('iframe', {
            // The version parameter makes browsers fetch map.html again after an update
            src: L.resource('view/geomate/map.html') + '?v=' + encodeURIComponent(UI_VERSION),
            style: 'width: 100%; height: 80vh; border: none;' // Use 80% of the viewport height
        });

        return E('div', { id: 'geomate-map-container', style: 'position: relative;' }, [
            this.nodes.frame,
            // Button to toggle the visibility of active connections
            E('button', {
                id: 'toggle-connections-button',
                type: 'button',
                style: `
                    position: absolute;
                    top: 10px;
                    right: 30px;
                    z-index: 1000;
                    padding: 8px 12px;
                    background-color: rgba(0, 123, 255, 0.8);
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                `,
                click: L.bind(this.toggleConnections, this)
            }, [ _('Active Connections') ])
        ]);
    },

    // Table of active connections, hidden until the toggle button shows it
    renderConnections: function() {
        // Define CSS styles for the active connections container and table
        var style = E('style', {}, `
            #active-connections-container {
                padding: 10px;
                box-sizing: border-box;
                background-color: #f9f9f9;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
                display: none; /* Hidden by default */
                margin-left: 9px; /* Add left margin */
            }
            #active-connections-container .table-wrapper {
                max-height: 400px;
                overflow-y: auto;
            }
            #active-connections-container table {
                width: 100%;
                border-collapse: collapse;
                font-family: Arial, sans-serif;
                font-size: 14px;
            }
            #active-connections-container th,
            #active-connections-container td {
                padding: 12px 8px;
                border-bottom: 1px solid #ddd;
                text-align: left;
            }
            #active-connections-container th {
                background-color: #607D8B;
                color: black;
                position: sticky;
                top: 0;
                z-index: 1;
            }
            #active-connections-container tr:nth-child(even) {
                background-color: #f2f2f2;
            }
            #active-connections-container tr:hover {
                background-color: #e0f7fa;
            }
        `);

        this.nodes.connectionsBody = E('tbody', { id: 'active-connections-table-body' });
        this.nodes.connections = E('div', { id: 'active-connections-container' }, [
            style,
            E('h3', { style: 'text-align: center;' }, [ _('Active Connections') ]),
            E('div', { class: 'table-wrapper' }, [
                E('table', { class: 'table' }, [
                    E('thead', {}, [
                        E('tr', {}, [
                            E('th', {}, [ _('IP') ]),
                            E('th', {}, [ _('Geo-Filter Name') ]),
                            E('th', {}, [ _('Status') ])
                        ])
                    ]),
                    this.nodes.connectionsBody
                ])
            ])
        ]);

        return this.nodes.connections;
    },

    // Show or hide the connections table; the map gets smaller while it is shown
    toggleConnections: function() {
        var box = this.nodes.connections,
            show = box.style.display !== 'block';

        box.style.display = show ? 'block' : 'none';
        this.nodes.frame.style.height = show ? '600px' : '80vh';
        if (show)
            box.scrollIntoView({ behavior: 'smooth' });
    },

    // Show the last status, health check and staged changes
    updateStatus: function() {
        var n = this.nodes,
            st = this.status,
            checks = this.health && this.health.checks,
            running = !!(st && st.running),
            count = L.toArray((this.pending || {}).geomate).length;

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
            ? _('Connections not updated since %s: the map shows the last known list').format(new Date(this.connectionsAt).toLocaleTimeString())
            : _('Connections unavailable');

        n.pending.style.display = count ? 'inline' : 'none';
        n.pending.textContent = (count == 1)
            ? _('1 change pending: active after Save & Apply')
            : _('%d changes pending: active after Save & Apply').format(count);
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
        var self = this, seq = this.pendingSeq;

        if (!this.statusBusy)
            this.statusBusy = Promise.all([
                L.resolveDefault(callGetStatus(), null),
                L.resolveDefault(callGetHealthCheck(), null),
                L.resolveDefault(callUciChanges(), null)
            ]).then(function(r) {
                self.status = r[0];
                self.health = r[1];
                self.statusLoaded = true;
                // A region action or Reset may have read newer staged changes meanwhile
                if (r[2] && seq == self.pendingSeq)
                    self.pending = r[2];
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
                if (!list)
                    return;
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

    // The one message listener of the view
    handleMessage: function(ev) {
        if (!this.isMapMessage(ev))
            return;

        var self = this, type = ev.data.type, d = ev.data.data || {};

        // Without write access nothing is staged; the map has no drawing tools then anyway
        if (this.readonly && /^region(Drawn|Edited|Deleted)$/.test(type))
            return this.sendMessageToMap((type == 'regionDrawn') ? 'regionDiscarded' : 'regionRejected', { token: d.token, reason: '' });

        switch (type) {
        case 'mapReady':
            this.mapReady = true;
            this.sendMessageToMap('setReadonly', { readonly: this.readonly });
            this.pushFilters();
            this.sendMessageToMap('updateConnections', this.connections);
            break;
        case 'regionDrawn':
            this.enqueue(d.token, function() { return self.openFilterModal(d.token, d.region); });
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
            color: filterColor(Math.max(index, 0), name),
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
    // header counts them
    stage: function() {
        var self = this;
        return uci.save().then(function() {
            return L.resolveDefault(callUciChanges(), null);
        }).then(function(changes) {
            if (changes) {
                self.pending = changes;
                self.pendingSeq++;
            }
            self.updateStatus();
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

    // A new circle was drawn: choose or create its filter. The circle stays pending on the map
    // until this modal ends with regionSaved, regionDiscarded or regionRejected
    openFilterModal: function(token, region) {
        var self = this,
            sections = uci.sections('geomate', 'geo_filter').filter(function(s) { return s.name; }),
            NEW = '+new',   // no UCI section id contains '+'
            choices = { '': _('-- Please choose --') },
            initial = {},
            sid = null;

        if (!validRegion(region))
            return Promise.reject(new Error(_('Invalid circle %s').format(region)));

        sections.forEach(function(s) {
            choices[s['.name']] = (s.enabled === '1') ? s.name : _('%s (disabled)').format(s.name);
        });
        choices[NEW] = _('New filter…');

        // Existing filter names match without regard to case
        var findFilter = function(name) {
            name = name.toLowerCase();
            return sections.find(function(s) { return s.name.toLowerCase() === name; }) || null;
        };

        // Every filter in config order, then 'New filter…'; without filters the name field shows at once
        var filterW = new ui.Select(sections.length ? '' : NEW, choices, {
            sort: [ '' ].concat(sections.map(function(s) { return s['.name']; }), [ NEW ])
        });

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
            return filterW.getValue() === NEW;
        };

        // The filter the region goes to: the picked one, or an existing one the typed name matches
        var target = function() {
            var picked = filterW.getValue(), typed = (nameW.getValue() || '').trim();
            if (picked === NEW)
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
            listHint = E('div', { 'class': 'cbi-value-description' });

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

            ui.showModal(_('New circle'), [
                E('div', { 'class': 'cbi-map' }, [ E('div', { 'class': 'cbi-section' }, [ body ]) ]),
                E('p', {}, [
                    _('More options:'), ' ',
                    E('a', { 'href': L.url('admin/services/geomate/geofilters') }, [ _('Geo Filters') ])
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
    // Like Save & Apply it waits for a running region action, so the count includes its change
    handleReset: function(ev) {
        var self = this;

        return Promise.resolve(this.busy).then(function() {
            return L.resolveDefault(callUciChanges(), null);
        }).then(function(changes) {
            if (changes) {
                self.pending = changes;
                self.pendingSeq++;
                self.updateStatus();
            }

            var pending = self.pending || {},
                count = L.toArray(pending.geomate).length,
                others = Object.keys(pending).filter(function(config) {
                    return config != 'geomate' && L.toArray(pending[config]).length;
                });

            if (!count) {
                ui.addNotification(null, E('p', {}, [ _('Geomate has no staged changes to revert.') ]), 'info');
                return;
            }

            // No null entries: dom.append in LuCI 23.05 and 26.036 renders them as the text "null"
            var body = [
                E('p', {}, [ (count == 1)
                    ? _('Geomate has 1 staged change. It is not active yet; reverting discards it.')
                    : _('Geomate has %d staged changes. They are not active yet; reverting discards them.').format(count) ]),
                E('p', {}, [ _('Like Revert in the Unsaved Changes dialog, this reverts the staged changes of every configuration in this session, then reloads the page.') ])
            ];
            if (others.length)
                body.push(E('p', {}, [ _('Also reverted: the staged changes of %s.').format(others.join(', ')) ]));
            body.push(E('div', { 'class': 'right' }, [
                E('button', { 'class': 'btn cbi-button-neutral', 'click': ui.hideModal }, [ _('Cancel') ]), ' ',
                E('button', { 'class': 'btn cbi-button-negative', 'click': ui.createHandlerFn(self, function() {
                    ui.hideModal();
                    ui.changes.revert();
                }) }, [ _('Revert') ])
            ]));

            ui.showModal(_('Revert staged changes?'), body);
        });
    },

    // Function to update the active connections table
    updateActiveConnectionsList: function() {
        var tbody = this.nodes && this.nodes.connectionsBody;
        if (!tbody) return;

        // Skip any connection object lacking filter_name to avoid errors
        dom.content(tbody, this.connections.filter(function(conn) {
            return conn && conn.filter_name;
        }).map(function(conn) {
            var status;

            // Determine the status based on connection data
            if (conn.is_allowed_ip) {
                status = _('Allowed (Whitelist)');
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

            // Cells take text nodes only: names and addresses never run as markup
            return E('tr', {}, [
                E('td', {}, [ conn.dst || _('Unknown') ]),
                E('td', {}, [ conn.filter_name ]),
                E('td', {}, [ status ])
            ]);
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
