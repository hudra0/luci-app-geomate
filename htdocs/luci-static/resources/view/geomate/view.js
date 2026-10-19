'use strict';
'require view';
'require form';
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

// Declare RPC methods to interact with the Geomate backend
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
        return true; // File exists
    }).catch(function(err) {
        // If stat fails, file likely doesn't exist
        return false;
    });
}

return view.extend({
    map: null,
    currentConnectionsData: [],
    allowedIPsData: [],
    pending: {},        // last uci.changes() result
    busy: null,         // promise chain that serializes region actions
    reported: {},       // region problems already shown, so a new map iframe does not repeat them

    // Load initial data required for the view
    load: function() {
        this.reported = {};
        return Promise.all([
            uci.load('geomate'),
            callGeomateConnections(),
            callGeomateAllowedIPs(),
            getServiceStatus(),
            L.resolveDefault(uci.changes(), {})
        ]).then(function(data) {
            var connectionsResult = data[1];
            var allowedIPsResult = data[2];
            var serviceStatus = data[3];
    
            this.currentConnectionsData = connectionsResult.connections || [];
            this.allowedIPsData = allowedIPsResult.allowed_ips || [];
            this.serviceStatus = serviceStatus; // Store the service status
            this.pending = data[4] || {};
    
            return data;
        }.bind(this)).catch(function(error) {
            console.error('Error loading data:', error);
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
        
            return E('div', { style: 'display: flex; flex-direction: column; margin-left: 8px;' }, [
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
            return E('div', { id: 'geomate-map-container', style: 'position: relative;' }, [
                E('iframe', {
                    // The version parameter makes browsers fetch map.html again after an update
                    src: L.resource('view/geomate/map.html') + '?v=' + encodeURIComponent(UI_VERSION),
                    style: 'width: 100%; height: 80vh; border: none;' // Use 80% of the viewport height
                }),
                // Button to toggle the visibility of active connections
                E('button', {
                    id: 'toggle-connections-button',
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
                    `
                }, _('Active Connections'))
            ]);
        };

        // Section to display active connections in a table
        s = m.section(form.TypedSection, '_active_connections');
        s.anonymous = true;
        s.render = function() {
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

            return E('div', {
                id: 'active-connections-container'
            }, [
                style,
                E('h3', { style: 'text-align: center;' }, _('Active Connections')),
                E('div', { class: 'table-wrapper' }, [
                    E('table', { class: 'table' }, [
                        E('thead', {}, [
                            E('tr', {}, [
                                E('th', {}, _('IP')),
                                E('th', {}, _('Geo-Filter Name')),
                                E('th', {}, _('Status'))
                            ])
                        ]),
                        E('tbody', { id: 'active-connections-table-body' })
                    ])
                ])
            ]);
        };

        return m.render().then(function(rendered) {
            self.map = m;
            self.setupMessageHandlers();
        
            // Handle the toggle button to show or hide active connections
            var toggleButton = rendered.querySelector('#toggle-connections-button');
            var connectionsContainer = rendered.querySelector('#active-connections-container');
            var mapIframe = rendered.querySelector('#geomate-map-container iframe');
            var originalMapHeight = null;
        
            if (mapIframe) {
                originalMapHeight = mapIframe.style.height || getComputedStyle(mapIframe).height;
            }
        
            toggleButton.addEventListener('click', function() {
                if (connectionsContainer.style.display === 'none' || connectionsContainer.style.display === '') {
                    connectionsContainer.style.display = 'block';
                    // Scroll to the "Active Connections" section smoothly
                    connectionsContainer.scrollIntoView({ behavior: 'smooth' });
                    // Reduce the height of the map for better visibility
                    if (mapIframe) {
                        mapIframe.style.height = '600px'; // Reduced height
                    }
                } else {
                    connectionsContainer.style.display = 'none';
                    // Reset the map height to its original value
                    if (mapIframe && originalMapHeight) {
                        mapIframe.style.height = originalMapHeight;
                    }
                }
            });

            // Send initial connections and Allowed IPs to the map after the map is ready
            window.addEventListener('message', function(event) {
                if (self.isMapMessage(event) && event.data.type === 'mapReady') {
                    self.pushFilters();
                    self.sendAllowedIPsToMap(self.allowedIPsData || []);
                    self.sendConnectionsToMap(self.currentConnectionsData || []);
                    self.updateActiveConnectionsList();
                    // Initial version check
                    self.checkForUpdates();

                    // Regularly update the service status - only after map is ready
                    poll.add(function() {
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

                                // Build compact health check display; messages stay text, never markup
                                dom.content(healthElement, Object.keys(checkLabels).filter(function(key) {
                                    return checks[key];
                                }).map(function(key) {
                                    var icon = icons[checks[key].status] || ['✓', '#10b981'];
                                    return E('span', { 'style': 'margin-right: 10px;', 'title': checks[key].message || '' }, [
                                        E('span', { 'style': 'color: ' + icon[1] + ';' }, [ icon[0] ]),
                                        ' ' + checkLabels[key]
                                    ]);
                                }));
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
                                modeContainer.style.display = 'flex';
                            }
                        });
                    }, 5); // check service status every 5 seconds

                    // Polling connections+allowedIPs
                    poll.add(function() {
                        return Promise.all([
                            callGeomateConnections(),
                            callGeomateAllowedIPs()
                        ]).then(function(results) {
                            var connectionsData = results[0].connections || [];
                            var allowedIPsData = results[1].allowed_ips || [];
                            self.currentConnectionsData = connectionsData;
                            self.allowedIPsData = allowedIPsData;
                            self.sendConnectionsToMap(connectionsData);
                            self.sendAllowedIPsToMap(allowedIPsData);
                            self.updateActiveConnectionsList();
                        }).catch(function(error) {
                            console.error('Error fetching data:', error);
                        });
                    }, 2); // Interval in seconds

                    // Check for version updates every 60 minutes
                    poll.add(function() {
                        return self.checkForUpdates();
                    }, 3600); // 3600 seconds
                }
            }, false);

            return rendered;
        });
    },

    // Only the map iframe of this page may send messages to the view
    isMapMessage: function(ev) {
        var frame = this.mapFrame();
        return ev.origin === window.location.origin && frame != null &&
            ev.source === frame.contentWindow && ev.data != null && typeof ev.data.type == 'string';
    },

    mapFrame: function() {
        return document.querySelector('#geomate-map-container iframe');
    },

    // Send a message to the map iframe
    sendMessageToMap: function(type, data) {
        var frame = this.mapFrame();
        if (frame && frame.contentWindow)
            frame.contentWindow.postMessage({ type: type, data: data }, window.location.origin);
    },

    sendConnectionsToMap: function(connections) {
        this.sendMessageToMap('updateConnections', connections);
    },

    sendAllowedIPsToMap: function(allowedIPs) {
        this.sendMessageToMap('updateAllowedIPs', allowedIPs);
    },

    // Handle region messages from the map iframe ('mapReady' is handled in render())
    setupMessageHandlers: function() {
        var self = this;
        window.addEventListener('message', function(ev) {
            if (!self.isMapMessage(ev))
                return;

            var d = ev.data.data || {};
            switch (ev.data.type) {
            case 'regionDrawn':
                self.enqueue(d.token, function() { return self.openFilterModal(d.token, d.region); });
                break;
            case 'regionEdited':
                self.enqueue(d.token, function() { return self.replaceRegion(d.token, d.sid, d.oldRegion, d.region); });
                break;
            case 'regionDeleted':
                self.enqueue(d.token, function() { return self.removeRegion(d.token, d.sid, d.oldRegion); });
                break;
            case 'regionInvalid':
                self.warnOnce(d.sid + ' ' + d.region, _('Filter %s has an invalid region "%s". It is not shown on the map.')
                    .format(self.filterName(d.sid), d.region));
                break;
            }
        }, false);
    },

    // Run region actions one after another: uci.save() reloads the configuration, so a second
    // action must not read it in between. A failed action hands its region back to the map.
    enqueue: function(token, fn) {
        var self = this;
        this.busy = Promise.resolve(this.busy).then(fn).catch(function(err) {
            var reason = _('Failed to stage the change: %s. Reload the page.').format((err && err.message) || err);
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
                    self.warnOnce(s['.name'] + ' option', _('Filter %s has a region written as "option allowed_region" (%s) instead of "list allowed_region". geomate ignores it at service start; only the periodic harvest applies it (to all geolocated IPs of the filter, after new IPs arrive) until the next restart, and the map does not show it. Redraw it on the map or fix it on the Geo Filters page; a region drawn for this filter replaces it.')
                        .format(s.name || s['.name'], s.allowed_region));
                return Object.assign(self.filterInfo(s['.name']), { regions: self.regionList(s['.name']) });
            }),
            stagedSids: Object.keys(staged)
        });
    },

    // Stage the in-memory changes in the LuCI session and say what that means. The note is a
    // toast inside the map: a LuCI notification would push the page and the map toolbar down
    stage: function() {
        var self = this;
        return uci.save().then(function() {
            return L.resolveDefault(uci.changes(), {});
        }).then(function(changes) {
            self.pending = changes || {};
            self.sendMessageToMap('toast', {
                text: _('Change staged. It takes effect only after Save & Apply; staged changes are lost on logout or session expiry.')
            });
        });
    },

    ackRegion: function(token, sid, region) {
        this.sendMessageToMap('regionSaved', Object.assign(this.filterInfo(sid), { token: token, region: region }));
    },

    rejectRegion: function(token, sid, reason) {
        reason = reason || _('Region of filter %s not found in the configuration. Reload the page.').format(this.filterName(sid));
        ui.addNotification(null, E('p', {}, [ reason ]), 'warning');
        this.sendMessageToMap('regionRejected', { token: token, reason: reason });
    },

    // A circle was moved or resized: replace the stored string it was loaded with
    replaceRegion: function(token, sid, oldRegion, region) {
        var list = this.regionList(sid),
            index = list.indexOf(oldRegion);

        if (!validRegion(region))
            return this.rejectRegion(token, sid, _('Region %s is not a valid circle (radius at least 1 m).').format(region));
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
            effect = _('Filter %s is disabled and keeps no region.');
        else if (monitor)
            effect = _('Without a region, filter %s puts no geolocated IP into its allowed or blocked set. Geomate runs in monitor mode and blocks no traffic.');
        else if (strict)
            effect = _('Without a region, filter %s puts no geolocated IP into its allowed or blocked set. Strict mode is on, so the filter blocks all its traffic except its allowed IPs.');
        else
            effect = _('Without a region, filter %s puts no geolocated IP into its allowed or blocked set, so it blocks no game server (strict mode is off).');

        return new Promise(function(resolve) {
            var button = function(cls, label, choice) {
                return E('button', { 'class': 'btn ' + cls, 'click': function() { ui.hideModal(); resolve(choice); } }, [ label ]);
            };
            var preferred = enabled
                ? button('cbi-button-negative', _('Delete and disable filter'), 'disable')
                : button('cbi-button-negative', _('Delete region'), 'keep');
            // No null entries: dom.append in LuCI 23.05 and 26.036 renders them as the text "null"
            var buttons = [ button('', _('Cancel'), null), ' ' ];
            if (enabled)
                buttons.push(button('cbi-button-action', _('Delete, keep filter enabled'), 'keep'), ' ');
            buttons.push(preferred);

            ui.showModal(_('Delete the last region of %h?').format(name), [
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
            return Promise.reject(new Error(_('Invalid region %s').format(region)));

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

        var ipPlaceholder = '192.168.1.0/24 or !192.168.1.128/25',
            portPlaceholder = '25200 25300 or 27015-27020';

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

        // Show the settings of the chosen filter, or the defaults for a new one
        var fill = function(sec) {
            Object.keys(fields).forEach(function(k) {
                var v = sec ? sec[k] : null;

                if (k == 'enabled')
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
                sid = secId;
                fill(sec);
            }

            fields.ip_list.node.querySelector('input').placeholder = suggestedList();
            // No null entries: dom.append in LuCI 23.05 and 26.036 renders them as the text "null"
            var hintText = [ !sec
                ? _('A new filter %s will be created.').format(name)
                : (sec.enabled === '1')
                    ? _('The region will be added to filter %s.').format(sec.name)
                    : _('The region will be added to filter %s, which is disabled.').format(sec.name) ];
            if (sec && typeof sec.allowed_region == 'string')
                hintText.push(' ' + _('It replaces the hand-written "option allowed_region" (%s).').format(sec.allowed_region));
            dom.content(hint, (!name || (!sec && !FILTER_NAME_RE.test(name))) ? null : hintText);

            var owner = name ? listOwner() : null;
            dom.content(listHint, owner ? [ _('%s is already the IP list of filter %s; both filters would share it.')
                .format(value('ip_list') || suggestedList(), owner.name || owner['.name']) ] : null);
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
                dom.content(status, [ _('Failed to upload file: %s').format(err.message) ]);
            });
        };

        // Upload to a new file at once; an existing list is only replaced after confirmation
        var uploadList = function(file) {
            var path = value('ip_list') || suggestedList();

            if (!/^\/etc\/geomate\.d\/[^\/]+$/.test(path) || path == '/etc/geomate.d/..')
                return dom.content(status, [ _('Choose a filter name or a list file in /etc/geomate.d/ first.') ]);

            // Geo data files and the updater's md5 registries live there too
            if (/\.(json|md5)$/i.test(path))
                return dom.content(status, [ _('%s is not an IP list file.').format(path) ]);

            fs.stat(path).then(function() {
                dom.content(status, [
                    _('%s already exists. Replace its content with %s?').format(path, file.name), ' ',
                    E('button', { 'class': 'btn cbi-button-negative', 'click': function() { writeList(path, file); } }, [ _('Overwrite') ]), ' ',
                    E('button', { 'class': 'btn', 'click': function() {
                        dom.content(status, [ _('Upload cancelled, %s was not changed.').format(path) ]);
                    } }, [ _('Keep file') ])
                ]);
            }, function(err) {
                if (err && err.name == 'NotFoundError')
                    return writeList(path, file);
                dom.content(status, [ _('Cannot check %s: %s').format(path, err.message) ]);
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
                        dom.content(status, [ _('The service creates the list file at its next start if it does not exist.') ]);
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
                    dom.content(hint, [ _('Choose a filter or "New filter…".') ]);

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

            ui.showModal(_('New region'), [
                E('div', { 'class': 'cbi-map' }, [ E('div', { 'class': 'cbi-section' }, [ body ]) ]),
                E('p', {}, [
                    _('All options of all filters:'), ' ',
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
                    throw new Error(_('The region was staged but its new filter %s was not found').format(name));
                sid = found['.name'];
            }
            self.ackRegion(token, sid, region);
        });
    },

    // form.Map.reset() renders a new map iframe, which loads its regions on mapReady
    handleReset: function(ev) {
        return this.map.reset().then(function() {
            ui.addNotification(null, E('p', _('Form values have been reset')), 'success');
        });
    },

    // Function to update the active connections table
    updateActiveConnectionsList: function() {
        var tbody = document.getElementById('active-connections-table-body');
        if (!tbody) return;

        // Skip any connection object lacking filter_name to avoid errors
        dom.content(tbody, this.currentConnectionsData.filter(function(conn) {
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
