'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';
'require rpc';

var callGetGeolocationStatus = rpc.declare({
    object: 'luci.geomate',
    method: 'getGeolocationStatus',
    expect: { status: {} }
});

// Store geolocation status globally for access in render functions
var geoStats = null;

// Format seconds to human readable string
function formatTime(seconds) {
    if (seconds < 60) return seconds + ' sec';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' min';
    return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'min';
}

return view.extend({
    load: function() {
        return Promise.all([
            callGetGeolocationStatus()
        ]).then(function(data) {
            geoStats = data[0] || null;
            return data;
        }).catch(function(err) {
            console.log('Failed to load geolocation status:', err);
            geoStats = null;
            return [];
        });
    },

    render: function() {
        var m, s, o;

        // Create main configuration map for Geomate
        m = new form.Map('geomate', _('Geo Filters'),
            _('Configure geographic filters and global settings for game server access.'));

        // **Geolocation Status Section** - Shows current IP geolocation progress
        s = m.section(form.TypedSection, 'global', _('Geolocation Status'));
        s.anonymous = true;
        s.addremove = false;

        o = s.option(form.DummyValue, '_geolocation_status');
        o.rawhtml = true;
        o.cfgvalue = function() {
            if (!geoStats || !geoStats.timestamp) {
                return '<em>' + _('No geolocation data available. Start the service and wait for the first cycle.') + '</em>';
            }

            var html = '<div class="cbi-value-description" style="padding: 10px; border: 1px solid var(--border-color-medium, #ccc); border-radius: 4px; margin-bottom: 10px;">';
            
            // Cycle info
            var lastUpdate = geoStats.last_update_ago || 0;
            var nextCycle = geoStats.next_cycle_in || 0;
            html += '<strong>' + _('Cycle:') + '</strong> ';
            html += _('Last update') + ' ' + formatTime(lastUpdate) + ' ' + _('ago');
            html += ', ' + _('next in') + ' ' + formatTime(nextCycle);
            
            // Geolocation info
            if (geoStats.geolocation) {
                var geoLastRun = geoStats.geolocation.last_run_ago || 0;
                var pendingIps = geoStats.geolocation.pending_ips || 0;
                html += '<br><strong>' + _('Geolocation:') + '</strong> ';
                if (geoLastRun > 0) {
                    html += _('Last run') + ' ' + formatTime(geoLastRun) + ' ' + _('ago');
                    html += ', <strong>' + pendingIps + '</strong> ' + _('IPs pending');
                } else {
                    html += '<em>' + _('Not yet run') + '</em>';
                }
            }
            
            html += '</div>';
            return html;
        };

        // **Global Settings Section**
        // This section contains the main configuration options for the Geomate service
        s = m.section(form.TypedSection, 'global', _('Global Settings'));
        s.anonymous = true;

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
        // Main section for configuring individual geographic filters
        s = m.section(form.GridSection, 'geo_filter', _('Geo Filters'));
        s.addremove = true;  // Allow adding and removing filters
        s.anonymous = true;

        // Filter name identifier
        o = s.option(form.Value, 'name', _('Name'));
        o.rmempty = false;

        // Status column - shows if filter rules are active or have errors
        o = s.option(form.DummyValue, '_status', _('Status'));
        o.modalonly = false;
        o.textvalue = function(section_id) {
            var filterName = uci.get('geomate', section_id, 'name');
            if (!filterName) return '-';
            
            // Check if this filter has NFT errors
            if (geoStats && geoStats.nft_error_filters && geoStats.nft_error_filters.length > 0) {
                // Filter name in error log might have spaces replaced with underscores
                var normalizedName = filterName.replace(/ /g, '_');
                for (var i = 0; i < geoStats.nft_error_filters.length; i++) {
                    if (geoStats.nft_error_filters[i] === normalizedName || 
                        geoStats.nft_error_filters[i] === filterName) {
                        return '✗';
                    }
                }
            }
            return '✓';
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
            
            if (total === 0) {
                return '0';
            }
            
            // Show percentage of geolocated IPs
            var percent = Math.min(100, Math.round((geo / total) * 100));
            
            if (percent >= 100) {
                return total + ' ✓';  // All geolocated
            } else {
                return total + ' (' + percent + '%)';  // Shows progress
            }
        };

        // Geographic regions that are allowed for this filter
        o = s.option(form.DynamicList, 'allowed_region', _('Allowed Regions'));
        o.rmempty = true;

        // Enable/disable individual filters
        o = s.option(form.Flag, 'enabled', _('Enable'));
        o.rmempty = false;
        o.default = '1';

        // Protocol selection (TCP/UDP)
        o = s.option(form.ListValue, 'protocol', _('Protocol'));
        o.value('tcp', 'TCP');
        o.value('udp', 'UDP');
        o.rmempty = false;

        // Source IP configuration
        o = s.option(form.Value, 'src_ip', _('Source IP'));
        o.datatype = 'list(neg(ip4addr))';
        o.placeholder = '192.168.1.0/24 or !192.168.1.128/25';
        o.rmempty = true;

        // Source port configuration
        o = s.option(form.Value, 'src_port', _('Source Port'));
		o.datatype = 'list(neg(portrange))';
        o.placeholder = '25200 25300 or 27015-27020';

        // Destination port configuration
        o = s.option(form.Value, 'dest_port', _('Destination Port'));
		o.datatype = 'list(neg(portrange))';
        o.placeholder = '25200 25300 or 27015-27020';

        // Whitelist for specific IP addresses
        o = s.option(form.DynamicList, 'allowed_ip', _('Allowed IPs'));
        o.datatype = 'list(neg(ip4addr))';
        o.placeholder = '192.168.1.0/24 or !192.168.1.128/25';
        o.rmempty = true;

        // Path to the IP list file
        o = s.option(form.Value, 'ip_list', _('IP List File'));
        o.rmempty = false;

        // Helper function to generate and set the IP list path
        function setIpListPath(section_id, map) {
            var name_field = map.lookupOption('name', section_id)[0];
            var ip_list_field = map.lookupOption('ip_list', section_id)[0];
            
            var name = name_field.formvalue(section_id);
            if (!name) {
                ui.addNotification(null, E('p', _('Please specify a filter name first.')));
                return null;
            }

            var filepath = '/etc/geomate.d/' + name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_servers.txt';
            ip_list_field.getUIElement(section_id).setValue(filepath);
            return filepath;
        }

        // Create Empty List button
        o = s.option(form.Button, '_create_empty', _(''));
        o.inputtitle = _('Create Empty List');
        o.inputstyle = 'apply';
        o.modalonly = true;
        o.onclick = function(ev) {
            setIpListPath(this.section.section, this.map);
        };

        // Upload List button
        o = s.option(form.Button, '_upload', _(''));
        o.inputtitle = _('Upload List');
        o.inputstyle = 'apply';
        o.modalonly = true;
        o.onclick = function(ev) {
            var filepath = setIpListPath(this.section.section, this.map);
            if (!filepath) return;

            var fileInput = E('input', {
                'type': 'file',
                'style': 'display:none',
                'change': function(ev) {
                    if (!ev.target.files[0]) return;

                    var reader = new FileReader();
                    reader.onload = function() {
                        var content = reader.result;
                        L.resolveDefault(fs.write(filepath, content), null).then(function(rc) {
                            if (rc === null)
                                ui.addNotification(null, E('p', _('Failed to upload file.')));
                            else
                                ui.addNotification(null, E('p', _('File uploaded successfully.')));
                        });
                    };
                    reader.readAsText(ev.target.files[0]);
                }
            });

            document.body.appendChild(fileInput);
            fileInput.click();
            document.body.removeChild(fileInput);
        };

        return m.render();
    }
});
