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

        // Create main configuration map for Geomate (no header - redundant with page title)
        m = new form.Map('geomate', '', '');

        // **Geolocation Status Section** - Shows cycle and geolocation progress
        s = m.section(form.TypedSection, 'global', _('Geolocation Status'));
        s.anonymous = true;
        s.addremove = false;

        o = s.option(form.DummyValue, '_geolocation_status');
        o.rawhtml = true;
        o.cfgvalue = function() {
            if (!geoStats || !geoStats.timestamp) {
                return '<em>' + _('No geolocation data available. Start the service and wait for the first cycle.') + '</em>';
            }

            var html = '<div style="padding: 8px 0;">';
            
            var opMode = geoStats.operational_mode || 'dynamic';
            var geoMode = geoStats.geolocation_mode || 'frequent';
            
            // Cycle info (not shown for static mode)
            if (opMode !== 'static') {
                var lastUpdate = geoStats.last_update_ago || 0;
                var nextCycle = geoStats.next_cycle_in || 0;
                html += '<div style="margin-bottom: 4px;">';
                html += '<strong>' + _('Cycle:') + '</strong> ';
                html += _('Last update') + ' ' + formatTime(lastUpdate) + ' ' + _('ago');
                html += ', ' + _('next in') + ' ' + formatTime(nextCycle);
                html += '</div>';
            }
            
            // Frequent geolocation info (only in frequent mode)
            if (geoMode === 'frequent' && geoStats.geolocation) {
                var geoLastRun = geoStats.geolocation.last_run_ago || 0;
                var pendingIps = geoStats.geolocation.pending_ips || 0;
                html += '<div style="margin-bottom: 4px;">';
                html += '<strong>' + _('Geolocation (frequent):') + '</strong> ';
                if (geoLastRun > 0 && geoLastRun < 86400) {
                    html += _('Last') + ' ' + formatTime(geoLastRun) + ' ' + _('ago');
                    html += ', <strong>' + pendingIps + '</strong> ' + _('IPs pending');
                } else {
                    html += '<em>' + _('Not yet run') + '</em>';
                }
                html += '</div>';
            }
            
            // Daily geolocation info (always shown)
            if (geoStats.geolocation_daily) {
                var dailyLastRun = geoStats.geolocation_daily.last_run_ago || 0;
                var dailyNextRun = geoStats.geolocation_daily.next_run_in || 0;
                html += '<div>';
                html += '<strong>' + _('Geolocation (daily):') + '</strong> ';
                if (dailyLastRun > 0 && dailyLastRun < 172800) {
                    var lastHours = Math.floor(dailyLastRun / 3600);
                    var nextHours = Math.floor(dailyNextRun / 3600);
                    html += _('Last') + ' ' + lastHours + 'h ' + _('ago');
                    html += ', ' + _('next in') + ' ~' + nextHours + 'h';
                } else {
                    html += '<em>' + _('Not yet run') + '</em>';
                }
                html += '</div>';
            }
            
            html += '</div>';
            return html;
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

        // Open for server tests: handled by the fast helper in the router's luci.geomate (see there)
        o = s.option(form.Value, 'burst_threshold', _('Open for server tests'),
            _('When a filter sees more than this many servers at the same time (for example Apex Legends testing every data centre while you log in), ' +
              'it lets all of them through for a short while, so logging in and server tests are never held up. ' +
              'Your regions apply again as soon as it is over. 0 turns this off. Works while the Geomate page is open and for 2 hours after.'));
        o.datatype = 'uinteger';
        o.placeholder = '10';

        o = s.option(form.Value, 'burst_seconds', _('Open for (seconds)'),
            _('How long the filter stays open after the last time it saw that many servers at once.'));
        o.datatype = 'range(5,600)';
        o.placeholder = '20';
        o.depends({ burst_threshold: /^(?!0$)/ });

        // Fast detection: while the Geomate page is open, the router helper (luci.geomate) checks every 0.25 s instead of
        // 0.5 s, and the map asks for news every half second instead of every second (view.js)
        o = s.option(form.Flag, 'fast_detection', _('Fast detection'),
            _('While the Geomate page (the map) is open, new game servers are detected and shown on the map twice as fast: the ' +
              'router checks every quarter second instead of every half second, and the map updates every half second instead ' +
              'of every second. No effect while the page is closed.') +
            '<br><strong>' + _('May affect performance: this uses more of the router’s CPU while the page is open, which can be felt on older or slower routers.') + '</strong>');
        o.rmempty = true;
        o.default = '0';

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
        o.inputstyle = 'action geomate-manual-geo';   // extra class: shown blue (see the theme styles)
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

        // Enable/disable individual filters
        o = s.option(form.Flag, 'enabled', _('Enable'));
        o.editable = true;
        o.rmempty = false;
        o.default = '1';

        // Filter name identifier
        o = s.option(form.Value, 'name', _('Name'));
        o.rmempty = false;
        // The name becomes part of the router's firewall set names, which allow only these characters
        o.validate = function(section_id, value) {
            if (value == null || String(value).trim() === '') return _('Enter a name');
            if (!/^[A-Za-z0-9_ .-]+$/.test(String(value).trim()))
                return _('Use only letters, numbers, spaces and _ . - (the router cannot use other characters in a filter name)');
            return true;
        };

        // Status column - shows if filter rules are active or have errors
        o = s.option(form.DummyValue, '_status', _('Status'));
        o.modalonly = false;
        o.textvalue = function(section_id) {
            var filterName = uci.get('geomate', section_id, 'name');
            var enabled = uci.get('geomate', section_id, 'enabled');
            
            if (!filterName) return '-';
            
            // Disabled filters show neutral status
            if (enabled !== '1') return '-';
            
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

        // Geographic regions that are allowed for this filter. The table shows each region's coordinates, one region per
        // line: every corner of a polygon, and the centre and radius of a circle. (Edited in the filter's edit window.)
        o = s.option(form.DynamicList, 'allowed_region', _('Allowed Regions'));
        o.rmempty = true;
        o.textvalue = function(section_id) {
            var list = L.toArray(this.cfgvalue(section_id)).filter(function(v) { return v != null && String(v).trim() !== ''; });
            if (!list.length) return E('em', {}, _('none'));
            function num(x) { var n = parseFloat(x); return isFinite(n) ? n.toFixed(4) : String(x).trim(); }
            function pt(lat, lng) { return '(' + num(lat) + ', ' + num(lng) + ')'; }
            return E('div', { 'class': 'geomate-regions' }, list.map(function(v) {
                v = String(v).trim();
                var m, text;
                if (/^polygon:/i.test(v)) {
                    var pts = v.slice(8).split(';').map(function(p) { return p.trim(); }).filter(Boolean);
                    if (pts.length > 1 && pts[0] === pts[pts.length - 1]) pts.pop();     // closing point repeats the first one
                    text = _('Polygon') + ': ' + pts.map(function(p) { var c = p.split(','); return c.length === 2 ? pt(c[0], c[1]) : p; }).join(', ');
                } else if ((m = /^circle:([^:]+):([^:]+):([0-9.]+)/i.exec(v))) {
                    var r = parseFloat(m[3]) || 0;
                    text = _('Circle') + ': ' + _('centre') + ' ' + pt(m[1], m[2]) + ', ' + _('radius') + ' ' +
                        (r >= 1000 ? (Math.round(r / 100) / 10) + ' km' : Math.round(r) + ' m');
                } else {
                    text = v;
                }
                return E('div', { 'class': 'geomate-region', 'title': v }, text);
            }));
        };

        // Protocol selection (TCP/UDP)
        o = s.option(form.ListValue, 'protocol', _('Protocol'));
        o.value('tcp', 'TCP');
        o.value('udp', 'UDP');
        o.rmempty = false;

        // In the filters table: a list (addresses, ports) one item per line, never broken in the middle
        function linesText(value) {
            var items = L.toArray(value).join(' ').split(/\s+/).filter(Boolean);
            if (!items.length) return E('em', {}, _('none'));
            return E('div', {}, items.map(function(x) { return E('span', { 'class': 'geomate-addr' }, x); }));
        }

        // Source IP configuration
        o = s.option(form.Value, 'src_ip', _('Source IP'),
            _('The device(s) this filter applies to. Several devices: separate their addresses with spaces, e.g. 192.168.1.50 192.168.1.60'));
        o.datatype = 'list(neg(ip4addr))';
        o.placeholder = '192.168.1.50 192.168.1.60 or 192.168.1.0/24';
        o.rmempty = true;
        o.cfgvalue = function(section_id) { return srcIpText(uci.get('geomate', section_id, 'src_ip')); };
        o.validate = function(section_id, value) { return srcIpCheck(value); };
        o.textvalue = function(section_id) { return linesText(this.cfgvalue(section_id)); };
        o.write = function(section_id, value) {
            var v = srcIpForRouter(value);
            if (v) uci.set('geomate', section_id, 'src_ip', v); else uci.unset('geomate', section_id, 'src_ip');
        };

        // Source port configuration
        o = s.option(form.Value, 'src_port', _('Source Port'));
		o.datatype = 'list(neg(portrange))';
        o.placeholder = '25200 25300 or 27015-27020';
        o.textvalue = function(section_id) { return linesText(this.cfgvalue(section_id)); };

        // Destination port configuration
        o = s.option(form.Value, 'dest_port', _('Destination Port'));
		o.datatype = 'list(neg(portrange))';
        o.placeholder = '25200 25300 or 27015-27020';
        o.textvalue = function(section_id) { return linesText(this.cfgvalue(section_id)); };

        // Whitelist for specific IP addresses
        o = s.option(form.DynamicList, 'allowed_ip', _('Allowed IPs'));
        o.datatype = 'list(neg(ip4addr))';
        o.placeholder = '192.168.1.0/24 or !192.168.1.128/25';
        o.rmempty = true;
        // In the table only the number is shown; "View hidden details" opens the list (a long list used to stretch the page)
        o.textvalue = function(section_id) {
            var list = L.toArray(this.cfgvalue(section_id)).filter(function(v) { return v != null && String(v).trim() !== ''; });
            if (!list.length) return E('em', {}, _('none'));
            var details = E('div', { 'class': 'geomate-ip-list', 'style': 'display:none' },
                list.map(function(ip) { return E('div', {}, String(ip).trim()); }));
            var btn = E('button', { 'type': 'button', 'class': 'cbi-button geomate-ip-toggle', 'aria-expanded': 'false' }, _('View hidden details'));
            btn.addEventListener('click', function(ev) {
                ev.preventDefault();
                ev.stopPropagation();
                var open = details.style.display === 'none';
                details.style.display = open ? '' : 'none';
                btn.textContent = open ? _('Hide details') : _('View hidden details');
                btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            });
            return E('div', { 'class': 'geomate-ips' }, [
                E('div', { 'class': 'geomate-ip-count' }, list.length === 1 ? _('1 address') : _('%d addresses').format(list.length)),
                btn,
                details
            ]);
        };

        // Path to the IP list file
        o = s.option(form.Value, 'ip_list', _('IP List File'));
        o.rmempty = false;
        // (the table shows the file name; the whole path is in its tooltip and in the edit window)
        o.textvalue = function(section_id) {
            var v = String(this.cfgvalue(section_id) || '').trim();
            if (!v) return E('em', {}, _('none'));
            return E('span', { 'title': v }, v.replace(/^.*\//, ''));
        };

        // IP expiry days - removes inactive IPs after specified days
        o = s.option(form.Value, 'ip_expiry_days', _('IP Expiry (Days)'),
            _('Automatically remove IPs not seen for this many days. Set to 0 to disable. ' +
              'Useful for games with dynamic servers where IPs change frequently.'));
        o.datatype = 'uinteger';
        o.placeholder = '0';
        o.default = '0';  // Default for existing filters: disabled
        o.rmempty = true;
        o.modalonly = true;

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

        return m.render().then(function(rendered) {
            rendered.classList.add('geomate-dumaos-theme');
            rendered.classList.add('geomate-filters-page');   // (lets this page use more of the window, see the style below)
            // The colours go in the page header, not inside the form: LuCI rebuilds the form's contents after Save & Apply,
            // which used to throw the style away and leave the page in the plain theme.
            var oldThemeStyle = document.getElementById('geomate-filters-theme-style');
            if (oldThemeStyle && oldThemeStyle.parentNode) oldThemeStyle.parentNode.removeChild(oldThemeStyle);
            document.head.appendChild(E('style', { id: 'geomate-filters-theme-style' }, `
/* DumaOS-inspired settings presentation only */
.geomate-dumaos-theme{--gm-panel:#17232d;--gm-border:#30414d;--gm-text:#eaf1f5;--gm-muted:#9eafb9;--gm-accent:#9bdc28;color:var(--gm-text)}
.geomate-dumaos-theme .cbi-section,.geomate-dumaos-theme .cbi-section-node{background:var(--gm-panel)!important;color:var(--gm-text)!important;border:1px solid var(--gm-border)!important;border-radius:10px!important;padding:16px!important;margin:12px 0 18px!important;box-shadow:0 6px 20px rgba(0,0,0,.16)}
.geomate-dumaos-theme .cbi-section h3,.geomate-dumaos-theme .cbi-section .cbi-section-title{color:var(--gm-text)!important;font-weight:700;letter-spacing:.02em}
.geomate-dumaos-theme .cbi-value-title,.geomate-dumaos-theme label,.geomate-dumaos-theme .cbi-section p,.geomate-dumaos-theme .cbi-section em,.geomate-dumaos-theme .cbi-section strong{color:var(--gm-text)}
.geomate-dumaos-theme .cbi-value-description,.geomate-dumaos-theme .description{color:var(--gm-muted)!important}
.geomate-dumaos-theme input,.geomate-dumaos-theme select,.geomate-dumaos-theme textarea{background:#0f1921!important;color:var(--gm-text)!important;border:1px solid #3a4d59!important;border-radius:6px!important}
.geomate-dumaos-theme input:focus,.geomate-dumaos-theme select:focus,.geomate-dumaos-theme textarea:focus{border-color:var(--gm-accent)!important;box-shadow:0 0 0 2px rgba(155,220,40,.14)!important}
.geomate-dumaos-theme .cbi-button,.geomate-dumaos-theme button{border-radius:6px!important}
.geomate-dumaos-theme .cbi-button-positive,.geomate-dumaos-theme .cbi-button-action{background:var(--gm-accent)!important;color:#111b12!important;border-color:var(--gm-accent)!important;font-weight:750}
/* This page uses more of the window (the theme keeps every page in a 1180px column) */
html:has(.geomate-filters-page) #maincontent{max-width:min(1800px,100%)!important;padding-left:16px!important;padding-right:16px!important;box-sizing:border-box}
html:has(.geomate-filters-page) header{padding-left:max(16px,calc((100% - 1800px) / 2))!important;padding-right:max(16px,calc((100% - 1800px) / 2))!important}
html:has(.geomate-filters-page) footer{padding-left:max(16px,calc((100% - 1800px) / 2))!important;padding-right:max(16px,calc((100% - 1800px) / 2))!important}
/* The settings: label and field side by side with room for the longer descriptions */
.geomate-dumaos-theme .cbi-value-field{max-width:900px}
/* The filters table: full width, words kept whole (addresses, ports and file names no longer break letter by letter) */
.geomate-dumaos-theme .cbi-tblsection{overflow-x:auto;max-width:100%}
.geomate-dumaos-theme .cbi-tblsection .cbi-section-table{width:100%}
.geomate-dumaos-theme .cbi-tblsection .tr.cbi-section-table-descr{display:none}
.geomate-dumaos-theme .cbi-tblsection .td,.geomate-dumaos-theme .cbi-tblsection td,.geomate-dumaos-theme .cbi-tblsection .th{overflow-wrap:normal;word-break:normal;padding-left:8px;padding-right:8px;vertical-align:middle}
.geomate-dumaos-theme .cbi-tblsection [data-name="name"]{min-width:90px}
.geomate-dumaos-theme .cbi-tblsection [data-name="src_ip"],.geomate-dumaos-theme .cbi-tblsection [data-name="src_port"],.geomate-dumaos-theme .cbi-tblsection [data-name="dest_port"]{max-width:200px}
.geomate-dumaos-theme .cbi-tblsection [data-name="ip_list"]{min-width:150px;max-width:260px;font-size:12px;overflow-wrap:anywhere}
.geomate-dumaos-theme .cbi-tblsection .cbi-section-actions{white-space:nowrap}
.geomate-dumaos-theme .geomate-addr{display:block;white-space:nowrap}
.geomate-dumaos-theme .cbi-tblsection [data-name="allowed_region"]{min-width:190px;max-width:520px;word-break:normal;overflow-wrap:anywhere;font-size:12px;line-height:1.4}
.geomate-dumaos-theme .cbi-tblsection [data-name="allowed_ip"]{min-width:150px;max-width:240px;font-size:12px;line-height:1.4}
.geomate-dumaos-theme .geomate-ip-count{color:var(--gm-text);margin-bottom:4px}
.geomate-dumaos-theme .cbi-button.geomate-ip-toggle{font-size:12px!important;padding:2px 10px!important;line-height:1.6!important;min-height:0!important;background:#263944!important;color:var(--gm-text)!important;border:1px solid #3a4d59!important}
.geomate-dumaos-theme .cbi-button.geomate-ip-toggle:hover{border-color:var(--gm-accent)!important}
.geomate-dumaos-theme .geomate-ip-list{margin-top:6px;max-height:220px;overflow-y:auto;padding:4px 6px;background:#0f1921;border:1px solid #30414d;border-radius:6px;font-family:monospace;font-size:12px;overflow-wrap:anywhere}
.geomate-dumaos-theme .geomate-ip-list>div+div{border-top:1px solid rgba(255,255,255,.06);padding-top:2px;margin-top:2px}
.cbi-value[data-name="allowed_ip"] .cbi-dynlist{max-height:260px;overflow-y:auto}
.geomate-dumaos-theme .geomate-region{padding:1px 0}
.geomate-dumaos-theme .geomate-region+.geomate-region{border-top:1px solid rgba(255,255,255,.08);margin-top:3px;padding-top:4px}
.geomate-dumaos-theme .cbi-button.geomate-manual-geo,.geomate-dumaos-theme .cbi-value[data-name="_manual_geolocation"] .cbi-button{background:#3b82f6!important;color:#ffffff!important;border-color:#3b82f6!important;font-weight:750}
.geomate-dumaos-theme .cbi-button.geomate-manual-geo:hover,.geomate-dumaos-theme .cbi-value[data-name="_manual_geolocation"] .cbi-button:hover{background:#5a9bff!important;border-color:#5a9bff!important}
.geomate-dumaos-theme table,.geomate-dumaos-theme .table{color:var(--gm-text)}
.geomate-dumaos-theme th{background:#263944!important;color:#eaf1f5!important}
.geomate-dumaos-theme td,.geomate-dumaos-theme th{border-color:#30414d!important}
`));
            return rendered;
        });
    }
});
