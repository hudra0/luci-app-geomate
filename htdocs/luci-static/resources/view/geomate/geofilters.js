'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';
'require dom';
'require rpc';

var callGetGeolocationStatus = rpc.declare({
    object: 'luci.geomate',
    method: 'getGeolocationStatus',
    expect: { status: {} }
});

// Store geolocation status globally for access in render functions
var geoStats = null;

// Staged changes of this LuCI session (uci changes): loaded with the page and again after every
// save of the form. The backend sees only what Save & Apply has committed
var pending = {};

// Format seconds to human readable string
function formatTime(seconds) {
    if (seconds < 60) return seconds + ' sec';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' min';
    return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'min';
}

// Suggested IP list path for a filter name (same rule as in view.js)
function ipListPath(name) {
    return '/etc/geomate.d/' + name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_servers.txt';
}

// Radius in meters of a region 'circle:<lat>:<lon>:<radius in meters>', or null when the string
// is no valid circle (finite numbers, |lat| <= 90, |lon| <= 180, radius >= 1)
function parseRegion(region) {
    var p = String(region).split(':');

    if (p.length !== 4 || p[0] !== 'circle' || !p.slice(1).every(function(x) { return /^-?\d+(\.\d+)?$/.test(x); }))
        return null;

    return (Math.abs(p[1]) <= 90 && Math.abs(p[2]) <= 180 && +p[3] >= 1) ? +p[3] : null;
}

// The regions of a filter as the service reads them. A hand-written 'option allowed_region'
// (a string) counts as no region: the service start and luci.geomate read only the list
function regionList(section_id) {
    var v = uci.get('geomate', section_id, 'allowed_region');
    return Array.isArray(v) ? v : [];
}

// Regions written as 'option allowed_region', which the service ignores
function regionIsOption(section_id) {
    return typeof uci.get('geomate', section_id, 'allowed_region') == 'string';
}

// Radius for the grid: '436 km', '0.5 km'
function formatRadius(meters) {
    var km = meters / 1000;
    return (km >= 10 ? Math.round(km) : Math.round(km * 10) / 10) + ' km';
}

// The session has uncommitted changes in this filter section
function isPending(sid) {
    return L.toArray(pending.geomate).some(function(change) { return change[1] === sid; });
}

// The running service reports nft errors for this filter. The error log may hold the name with
// spaces replaced by underscores
function hasNftError(name) {
    return !!geoStats && L.toArray(geoStats.nft_error_filters).some(function(n) {
        return n === name || n === name.replace(/ /g, '_');
    });
}

// A status line under the button of a form.Button option, in opt.status
function withStatus(opt) {
    var renderWidget = opt.renderWidget;

    opt.renderWidget = function() {
        var nodes = renderWidget.apply(this, arguments);

        this.status = E('div', { 'class': 'cbi-value-description' });
        nodes.appendChild(this.status);
        return nodes;
    };
}

// Filter name in the open modal, as typed
function formName(map, sid) {
    return String(map.lookupOption('name', sid)[0].formvalue(sid) || '').trim();
}

// Path of the IP list that the buttons of this option work on: the file name field, else the
// name suggested for the filter. Says why not in the option's status line and returns null
// when that is no IP list file in /etc/geomate.d
function listPath(opt, sid) {
    var name = formName(opt.map, sid),
        path = String(opt.map.lookupOption('ip_list', sid)[0].formvalue(sid) || '').trim() || (name ? ipListPath(name) : ''),
        error = null;

    if (!/^\/etc\/geomate\.d\/[^\/]+$/.test(path) || path == '/etc/geomate.d/..')
        error = _('Choose a filter name or a list file in /etc/geomate.d/ first.');
    // Geo data files and the updater's md5 registries live there too
    else if (/\.(json|md5)$/i.test(path))
        error = _('%s is not an IP list file.').format(path);

    dom.content(opt.status, error ? [ error ] : null);
    return error ? null : path;
}

// Write the chosen file as the IP list. A new file is written at once; an existing list is
// replaced only after the user confirmed
function uploadList(opt, sid, path, file) {
    var status = opt.status;

    var write = function() {
        dom.content(status, [ _('Uploading...') ]);
        return file.text().then(function(text) {
            return fs.write(path, text);
        }).then(function() {
            opt.map.lookupOption('ip_list', sid)[0].getUIElement(sid).setValue(path);
            dom.content(status, [ _('Uploaded %s to %s.').format(file.name, path) ]);
        }).catch(function(err) {
            dom.content(status, [ _('Failed to upload file: %s').format(err.message) ]);
        });
    };

    return fs.stat(path).then(function() {
        dom.content(status, [
            _('%s already exists. Replace its content with %s?').format(path, file.name), ' ',
            E('button', { 'class': 'btn cbi-button-negative', 'click': write }, [ _('Overwrite') ]), ' ',
            E('button', { 'class': 'btn', 'click': function() {
                dom.content(status, [ _('Upload cancelled, %s was not changed.').format(path) ]);
            } }, [ _('Keep file') ])
        ]);
    }, function(err) {
        if (err && err.name == 'NotFoundError')
            return write();
        dom.content(status, [ _('Cannot check %s: %s').format(path, err.message) ]);
    });
}

return view.extend({
    load: function() {
        return Promise.all([
            callGetGeolocationStatus().catch(function(err) {
                console.log('Failed to load geolocation status:', err);
                return null;
            }),
            L.resolveDefault(uci.changes(), {})
        ]).then(function(data) {
            geoStats = data[0] || null;
            pending = data[1] || {};
            return data;
        });
    },

    render: function() {
        var m, s, o, filters;

        // Create main configuration map for Geomate (no header - redundant with page title)
        m = new form.Map('geomate', '', '');

        // Saving the form reloads the configuration: fetch the staged changes again, so that the
        // status column does not call a change active that only waits for Save & Apply
        var loadMap = m.load, firstLoad = true;
        m.load = function() {
            var load = loadMap.apply(this, arguments);

            if (firstLoad) {
                firstLoad = false;
                return load;
            }
            return Promise.all([ load, L.resolveDefault(uci.changes(), null) ]).then(function(data) {
                pending = data[1] || pending;
                return data[0];
            });
        };

        // **Geolocation Status Section** - Shows cycle and geolocation progress
        s = m.section(form.TypedSection, 'global', _('Geolocation Status'));
        s.anonymous = true;
        s.addremove = false;

        o = s.option(form.DummyValue, '_geolocation_status');
        // Built from nodes, not HTML strings. This widget replaces the rendering of DummyValue, which
        // takes a string value
        o.renderWidget = function() {
            if (!geoStats || !geoStats.timestamp)
                return E('em', {}, _('No geolocation data available. Start the service and wait for the first cycle.'));

            var opMode = geoStats.operational_mode || 'dynamic';
            var geoMode = geoStats.geolocation_mode || 'frequent';
            var notRun = function() { return E('em', {}, _('Not yet run')); };
            var lines = [];

            var line = function(title, text) {
                lines.push(E('div', { 'style': 'margin-bottom: 4px;' }, [ E('strong', {}, title), ' ', text ]));
            };

            // Cycle info (not shown for static mode)
            if (opMode !== 'static')
                line(_('Cycle:'), _('Last update %s ago, next in %s')
                    .format(formatTime(geoStats.last_update_ago || 0), formatTime(geoStats.next_cycle_in || 0)));

            // Frequent geolocation info (only in frequent mode)
            if (geoMode === 'frequent' && geoStats.geolocation) {
                var geoLastRun = geoStats.geolocation.last_run_ago || 0;
                line(_('Geolocation (frequent):'), (geoLastRun > 0 && geoLastRun < 86400)
                    ? _('Last %s ago, %d IPs pending').format(formatTime(geoLastRun), geoStats.geolocation.pending_ips || 0)
                    : notRun());
            }

            // Daily geolocation info (always shown)
            if (geoStats.geolocation_daily) {
                var dailyLastRun = geoStats.geolocation_daily.last_run_ago || 0;
                var dailyNextRun = geoStats.geolocation_daily.next_run_in || 0;
                line(_('Geolocation (daily):'), (dailyLastRun > 0 && dailyLastRun < 172800)
                    ? _('Last %dh ago, next in ~%dh').format(Math.floor(dailyLastRun / 3600), Math.floor(dailyNextRun / 3600))
                    : notRun());
            }

            return E('div', { 'style': 'padding: 8px 0;' }, lines);
        };

        // **Global Settings Section**
        // This section contains the main configuration options for the Geomate service
        s = m.section(form.TypedSection, 'global', _('Global Settings'));
        s.anonymous = true;

        // **Enable Option**
        // Main switch to enable/disable the entire Geomate service
        o = s.option(form.Flag, 'enabled', _('Enable'),
            _('Enable or disable Geomate'));
        o.rmempty = false;

        // **Strict Mode Option**
        // When disabled, untracked connections are allowed. When enabled, all untracked connections are blocked
        o = s.option(form.Flag, 'strict_mode', _('Strict Mode'),
            _('When enabled, only known and allowed game servers are accessible. When disabled, both allowed and untracked server connections are permitted. ' +
              'Keep this disabled when you start using a new game or have no complete IP list - this allows Geomate to learn new server IPs ' +
              'while you play. Once Geomate has detected all/most required game servers and added them to its list, you can enable ' +
              'Strict Mode to fully apply your geographic filters.'));
        o.rmempty = false;

        // **Debug Level Option**
        // Controls the verbosity of logging (0=minimal, 1=normal, 2=verbose)
        o = s.option(form.Value, 'debug_level', _('Debug Level'),
            _('Set the debug level (e.g., 0, 1, 2)'));
        o.datatype = 'uinteger';
        o.placeholder = '0';
        o.default = '0';  // Same default as the backend
        o.rmempty = false;

        // Manual Geolocation Button
        o = s.option(form.Button, '_manual_geolocation', _('Manual Geolocation'));
        o.inputtitle = _('Run Manual Geolocation');
        o.inputstyle = 'action';
        o.onclick = function(ev) {
            return ui.showModal(_('Manual Geolocation'), [
                E('div', { 'class': 'alert-message warning' }, [
                    E('strong', {}, _('Warning:')),
                    E('p', {}, _('Running manual geolocation may:')),
                    E('ul', {}, [
                        E('li', {}, _('Temporarily affect the filtering of game servers')),
                        E('li', {}, _('Disconnect you from your current game')),
                        E('li', {}, _('Take several minutes to complete')),
                        E('li', {}, _('Use API quota for IP geolocation'))
                    ])
                ]),
                E('div', { 'class': 'right' }, [
                    E('button', {
                        'class': 'btn',
                        'click': ui.hideModal
                    }, _('Cancel')),
                    E('button', {
                        'class': 'btn cbi-button-positive',
                        'click': function() {
                            ui.hideModal();
                            ui.addNotification(null, E('p', {}, _('Manual geolocation process started. This process runs in the background and may take several minutes to complete.')), 'info');
                            
                            return fs.exec_direct('/etc/geolocate.sh', [])
                                .catch(function(err) {
                                    ui.addNotification(null, E('p', {}, _('Failed to start geolocation process: ') + err.message), 'error');
                                });
                        }
                    }, _('Proceed'))
                ])
            ]);
        };

        // **Operational Mode Option**
        // Choose between dynamic (automatic) and static (predefined) IP lists
        o = s.option(form.ListValue, 'operational_mode', _('Operational Mode'),
            _('Choose between dynamic (automatic) or static (predefined) IP lists'));
        o.value('dynamic', _('Dynamic - Build IP lists automatically'));
        o.value('static', _('Static - Use predefined IP lists'));
        o.value('monitor', _('Monitor - Only visualize connections, no blocking'));
        o.default = 'dynamic';
        o.rmempty = false;

        // **Geolocation Mode Option**
        // Choose how often to update IP geolocation data
        o = s.option(form.ListValue, 'geolocation_mode', _('Geolocation Update Mode'),
            _('Choose how often to update IP geolocation data'));
        o.value('frequent', _('Frequent - Update every 30-60 minutes'));
        o.value('daily', _('Daily - Update once per day'));
        o.default = 'frequent';
        o.rmempty = false;

        // **Geo Filters Section**
        // Main section for configuring individual geographic filters. The table shows only the
        // options that fit the page; the others are edited in the dialog of a filter
        s = m.section(form.GridSection, 'geo_filter', _('Geo Filters'));
        s.addremove = true;  // Allow adding and removing filters
        s.anonymous = true;
        s.modaltitle = function(section_id) {
            return _('Geo filter: %h').format(uci.get('geomate', section_id, 'name') || _('new'));
        };
        filters = s;

        // Enable/disable individual filters
        o = s.option(form.Flag, 'enabled', _('Enable'));
        o.editable = true;
        o.rmempty = false;
        o.default = '1';

        // Filter name identifier
        o = s.option(form.Value, 'name', _('Name'));
        o.rmempty = false;

        // Status column - what the running service does with the filter. Staged changes are not
        // active before Save & Apply, and the service sees only what that has committed
        o = s.option(form.DummyValue, '_status', _('Status'));
        o.modalonly = false;
        o.textvalue = function(section_id) {
            var filterName = uci.get('geomate', section_id, 'name');
            var enabled = uci.get('geomate', section_id, 'enabled') === '1';
            var staged = isPending(section_id);
            var problems = [];

            if (!filterName || (!enabled && !staged)) return '–';

            if (enabled) {
                // The service does not start while Geomate is disabled globally
                if (uci.get('geomate', 'global', 'enabled') !== '1') problems.push(_('service disabled'));
                if (hasNftError(filterName)) problems.push(_('nft error'));
                if (regionIsOption(section_id)) problems.push(_('regions ignored (option, not list)'));
                else if (!regionList(section_id).some(function(r) { return parseRegion(r) !== null; })) problems.push(_('no regions'));
                if (!uci.get('geomate', section_id, 'ip_list')) problems.push(_('no IP list'));
            }

            if (staged)
                return E('span', { 'title': _('Staged changes take effect only after Save & Apply; they are lost on logout or session expiry.') },
                    [ _('pending (Save & Apply)') + (problems.length ? ' · ' + problems.join(', ') : '') ]);

            return problems.length ? problems.join(', ') : _('active');
        };

        // IP Stats column - shows geolocation progress per filter
        o = s.option(form.DummyValue, '_ip_stats', _('IPs/Located'));
        o.modalonly = false;
        o.textvalue = function(section_id) {
            var filterName = uci.get('geomate', section_id, 'name');
            if (!filterName || !geoStats || !geoStats.filters) {
                return '-';
            }
            
            var stats = geoStats.filters[filterName];
            if (!stats) {
                return _('No data');
            }
            
            var total = stats.total_ips || 0;
            var geo = stats.geolocated || 0;
            
            // Geo data of IPs that left the list stays until the next full geolocation. Both
            // values are line counts (wc -l): a list without a final newline counts one IP less,
            // so one more geo data line than list lines proves nothing
            if (geo > total + 1) {
                return E('span', { 'title': _('The geo data holds at least %d IPs that are not in the list any more. The next full geolocation drops them.').format(geo - total - 1) },
                    [ total + ' (' + _('stale geo data') + ')' ]);
            }

            if (total === 0) {
                return '0';
            }
            
            // Show percentage of geolocated IPs
            var percent = Math.round((geo / total) * 100);
            
            if (percent >= 100) {
                return total + ' ✓';  // All geolocated
            } else {
                return total + ' (' + percent + '%)';  // Shows progress
            }
        };

        // Regions column - number and radii of the circles, with a link to the map
        o = s.option(form.DummyValue, '_regions', _('Regions'));
        o.modalonly = false;
        o.textvalue = function(section_id) {
            var regions = regionList(section_id);
            var radii = regions.map(parseRegion).filter(function(r) { return r !== null; });
            var parts = radii.map(formatRadius);
            var invalid = regions.length - radii.length;
            var nodes;

            if (regionIsOption(section_id)) return _('ignored: option, not list');
            if (!regions.length) return '–';

            if (invalid) parts.push(_('%d invalid').format(invalid));
            nodes = [ (radii.length == 1 ? _('1 circle') : _('%d circles').format(radii.length)) + ' · ' + parts.join(', ') ];
            if (radii.length)
                nodes.push(' ', E('a', { 'href': L.url('admin/services/geomate/view') + '#focus=' + encodeURIComponent(section_id) },
                    [ _('Show on map') ]));
            return E('span', {}, nodes);
        };

        // Geographic regions that are allowed for this filter
        o = s.option(form.DynamicList, 'allowed_region', _('Allowed Regions'), _('Easier to edit on the map'));
        o.rmempty = true;
        o.modalonly = true;
        o.placeholder = 'circle:48.137:11.575:50000';
        o.validate = function(section_id, value) {
            return value === '' || parseRegion(value) !== null ||
                _('Expecting: %s').format(_('circle:<latitude>:<longitude>:<radius in meters>'));
        };

        // Protocol selection (TCP/UDP)
        o = s.option(form.ListValue, 'protocol', _('Protocol'));
        o.value('tcp', 'TCP');
        o.value('udp', 'UDP');
        o.rmempty = false;
        o.modalonly = true;

        // Source IP configuration
        o = s.option(form.Value, 'src_ip', _('Source IP'));
        o.datatype = 'list(neg(ip4addr))';
        o.placeholder = '192.168.1.0/24 or !192.168.1.128/25';
        o.rmempty = true;
        o.modalonly = true;

        // Source port configuration
        o = s.option(form.Value, 'src_port', _('Source Port'));
        o.datatype = 'list(neg(portrange))';
        o.placeholder = '25200 25300 or 27015-27020';
        o.modalonly = true;

        // Destination port configuration
        o = s.option(form.Value, 'dest_port', _('Destination Port'));
        o.datatype = 'list(neg(portrange))';
        o.placeholder = '25200 25300 or 27015-27020';
        o.modalonly = true;

        // Whitelist for specific IP addresses
        o = s.option(form.DynamicList, 'allowed_ip', _('Allowed IPs'));
        o.datatype = 'list(neg(ip4addr))';
        o.placeholder = '192.168.1.0/24 or !192.168.1.128/25';
        o.rmempty = true;
        o.modalonly = true;

        // Path to the IP list file
        o = s.option(form.Value, 'ip_list', _('IP List File'));
        o.rmempty = false;
        o.modalonly = true;

        // IP expiry days - removes inactive IPs after specified days
        o = s.option(form.Value, 'ip_expiry_days', _('IP Expiry (Days)'),
            _('Automatically remove IPs not seen for this many days. Set to 0 to disable. ' +
              'Useful for games with dynamic servers where IPs change frequently.'));
        o.datatype = 'uinteger';
        o.placeholder = '0';
        o.default = '0';  // Default for existing filters: disabled
        o.rmempty = true;
        o.modalonly = true;

        // Create Empty List button: only fills in the file name
        o = s.option(form.Button, '_create_empty', _('Create IP List'));
        o.inputtitle = _('Create Empty List');
        o.inputstyle = 'apply';
        o.modalonly = true;
        withStatus(o);
        o.onclick = function(ev, section_id) {
            var name = formName(this.map, section_id);

            if (!name)
                return dom.content(this.status, [ _('Please specify a filter name first.') ]);

            this.map.lookupOption('ip_list', section_id)[0].getUIElement(section_id).setValue(ipListPath(name));
            dom.content(this.status, [ _('The service creates the list file at its next start if it does not exist.') ]);
        };

        // Upload List button: writes the chosen file as the IP list, an existing list only
        // after confirmation
        o = s.option(form.Button, '_upload', _('Upload IP List'));
        o.inputtitle = _('Upload List');
        o.inputstyle = 'apply';
        o.modalonly = true;
        withStatus(o);
        o.onclick = function(ev, section_id) {
            var self = this;

            if (!listPath(this, section_id))
                return;

            // One hidden input per dialog, kept in the DOM: a detached input may lose its change event
            if (!this.fileInput || !this.fileInput.isConnected) {
                this.fileInput = E('input', { 'type': 'file', 'style': 'display: none', 'change': function(ev) {
                    var file = ev.target.files[0], path = listPath(self, section_id);

                    ev.target.value = '';
                    if (file && path)
                        uploadList(self, section_id, path, file);
                } });
                this.status.parentNode.appendChild(this.fileInput);
            }
            this.fileInput.click();
        };

        return m.render().then(function(node) {
            // '#edit=<section>' (link of the map's region dialog) opens the dialog of that filter
            var edit = /^#edit=([^&]+)$/.exec(window.location.hash), sid = null;

            if (edit) {
                try { sid = decodeURIComponent(edit[1]); } catch (e) { sid = null; }
                window.history.replaceState(null, '', window.location.pathname + window.location.search);

                // After the view has put the form into the page
                if (sid && (uci.get('geomate', sid) || {})['.type'] === 'geo_filter')
                    window.setTimeout(function() { filters.renderMoreOptionsModal(sid); }, 0);
            }

            return node;
        });
    }
});
