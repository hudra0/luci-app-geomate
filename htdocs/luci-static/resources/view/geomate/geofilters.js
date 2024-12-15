'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';

return view.extend({
    render: function() {
        var m, s, o;

        // Create main configuration map for Geomate
        m = new form.Map('geomate', _('Geo Filters'),
            _('Configure geographic filters and global settings for game server access.'));

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
            _('Enable or disable strict mode'));
        o.rmempty = false;

        // **Debug Level Option**
        // Controls the verbosity of logging (0=minimal, 1=normal, 2=verbose)
        o = s.option(form.Value, 'debug_level', _('Debug Level'),
            _('Set the debug level (e.g., 0, 1, 2)'));
        o.datatype = 'uinteger';
        o.placeholder = '0';
        o.rmempty = false;

        // **Operational Mode Option**
        // Choose between dynamic (automatic) and static (predefined) IP lists
        o = s.option(form.ListValue, 'operational_mode', _('Operational Mode'),
            _('Choose between dynamic (automatic) or static (predefined) IP lists'));
        o.value('dynamic', _('Dynamic - Build IP lists automatically'));
        o.value('static', _('Static - Use predefined IP lists'));
        o.default = 'dynamic';
        o.rmempty = false;

        // **Geo Filters Section**
        // Main section for configuring individual geographic filters
        s = m.section(form.GridSection, 'geo_filter', _('Geo Filters'));
        s.addremove = true;  // Allow adding and removing filters
        s.anonymous = true;

        // Filter name identifier
        o = s.option(form.Value, 'name', _('Name'));
        o.rmempty = false;

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
