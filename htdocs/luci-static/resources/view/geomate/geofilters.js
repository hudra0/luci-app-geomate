'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';
'require dom';
'require rpc';
'require validation';

var callGetGeolocationStatus = rpc.declare({
    object: 'luci.geomate',
    method: 'getGeolocationStatus',
    expect: { status: {} }
});

// LAN devices for the Source IP suggestions (same calls as LuCI's Static Leases page). The
// luci-app-geomate ACL grants both; a ubus error such as "Access denied" resolves to {}
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
// resolving to {}, which would look like "nothing staged" (same call as in view.js)
var callUciChanges = rpc.declare({
    object: 'uci',
    method: 'changes',
    expect: { changes: {} },
    reject: true
});

// Store geolocation status globally for access in render functions
var geoStats = null;

// Source IP suggestions and host names (hostChoices), loaded with the page
var hosts = { keys: [], labels: {}, names: {} };

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

// The message of an error without the stack trace, which L.raise() appends to RPC errors (same
// as in view.js)
function errorText(err) {
    return String((err && err.message) || err).split('\n')[0];
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

// Regions written as 'option allowed_region', which the service start skips
function regionIsOption(section_id) {
    return typeof uci.get('geomate', section_id, 'allowed_region') == 'string';
}

// Radius for the grid: '436 km', '0.5 km'
function formatRadius(meters) {
    var km = meters / 1000;
    return _('%s km').format(km >= 10 ? Math.round(km) : Math.round(km * 10) / 10);
}

// Entries of src_ip, src_port or dest_port as the config has them, split at white space like
// the service does. A port 'any' is no restriction (an option that says only 'any' adds no
// match to the rule). A Source IP address gets the name a host hint has for it; the
// exceptions ('!' or '!=', also written apart from the address) follow the other entries as
// one 'except a, b', or 'any except a, b' without other entries
function matchItems(section_id, option) {
    var value = uci.get('geomate', section_id, option), items = [], except = [];

    if (option != 'src_ip')
        return L.toArray(L.toArray(value).join(' ')).filter(function(v) { return v !== 'any'; }).join(', ');

    srcIpEntries(value).forEach(function(v) {
        var m = /^(!=?)?(.*)$/.exec(v),
            addr = hosts.names.hasOwnProperty(m[2]) ? '%s (%s)'.format(m[2], hosts.names[m[2]]) : m[2];

        (m[1] ? except : items).push(addr);
    });
    if (except.length)
        items.push((items.length ? _('except %s') : _('any except %s')).format(except.join(', ')));
    return items.join(', ');
}

// The backend reports this feature token ('capabilities' of getGeolocationStatus, from
// '/etc/geomate.sh capabilities'). Unknown, as with an older backend or a failed request,
// counts as not supported
function hasCapability(token) {
    return !!geoStats && Array.isArray(geoStats.capabilities) && geoStats.capabilities.indexOf(token) > -1;
}

// Source IP suggestions from luci-rpc getHostHints, labelled like LuCI's Static Leases page:
// 'IP (name)', without a name 'IP (MAC)'. The router's own addresses (getNetworkDevices) and
// 127.0.0.0/8 are left out: a geo filter for them has no use. An address of two hosts counts
// once. Returns { keys: the addresses in numeric order, labels: { address: node }, names:
// { address: host name } }; a label is a node, because LuCI puts a string label in as HTML
// (same function in view.js)
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
// one exception only when it is the whole value (same function in view.js)
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
// keeps the field invalid; a dropdown opens to show its error (same function in view.js)
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
// '!= a.b.c.d' shows as '!=a.b.c.d' (same function in view.js)
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

// Source IP with several entries: a form.DynamicList whose widget splits pasted entries
var SrcIpList = form.DynamicList.extend({
    renderWidget: function(/* section_id, option_index, cfgvalue */) {
        var node = form.DynamicList.prototype.renderWidget.apply(this, arguments);

        splitEntries(dom.findClassInstance(node));
        return node;
    }
});

// The traffic a filter looks at, as the rule in the service is built from protocol, src_ip,
// src_port and dest_port: 'UDP from 192.168.2.208 port 3074, 3075'. A missing option adds no
// match, so 'Any traffic' is the filter without any. Ports without a protocol match TCP and
// UDP: the service has no port match without a protocol and adds both
function matchText(section_id) {
    var proto = String(uci.get('geomate', section_id, 'protocol') || '').trim().toUpperCase();
    var ips = matchItems(section_id, 'src_ip');
    var sport = matchItems(section_id, 'src_port');
    var dport = matchItems(section_id, 'dest_port');
    var from = (ips && sport) ? _('from %s port %s').format(ips, sport)
        : ips ? _('from %s').format(ips)
        : sport ? _('from port %s').format(sport) : '';
    var to = dport ? _('to port %s').format(dport) : '';

    if (!from && !to)
        return proto ? _('%s traffic').format(proto) : _('Any traffic');

    return [ proto || ((sport || dport) ? 'TCP/UDP' : _('Any protocol')), from, to ].filter(Boolean).join(' ');
}

// The session has uncommitted changes in this section, or in this option of it
function isPending(sid, option) {
    return L.toArray(pending.geomate).some(function(change) {
        return change[1] === sid && (option == null || change[2] === option);
    });
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

    // A file directly in /etc/geomate.d; '.' and '..' name a directory
    if (!/^\/etc\/geomate\.d\/(?!\.\.?$)[^\/]+$/.test(path))
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
            dom.content(status, [ _('Failed to upload file: %s').format(errorText(err)) ]);
        });
    };

    return fs.stat(path).then(function() {
        dom.content(status, [
            _('%s already exists. Replace it with %s?').format(path, file.name), ' ',
            E('button', { 'class': 'btn cbi-button-negative', 'click': write }, [ _('Replace') ]), ' ',
            E('button', { 'class': 'btn', 'click': function() {
                dom.content(status, [ _('Upload cancelled.') ]);
            } }, [ _('Cancel') ])
        ]);
    }, function(err) {
        if (err && err.name == 'NotFoundError')
            return write();
        dom.content(status, [ _('Cannot check %s: %s').format(path, errorText(err)) ]);
    });
}

return view.extend({
    load: function() {
        return Promise.all([
            callGetGeolocationStatus().catch(function(err) {
                console.log('Failed to load geolocation status:', err);
                return null;
            }),
            L.resolveDefault(callUciChanges(), {}),
            L.resolveDefault(callHostHints(), {}),
            L.resolveDefault(callNetworkDevices(), {})
        ]).then(function(data) {
            geoStats = data[0] || null;
            pending = data[1] || {};
            hosts = hostChoices(data[2], data[3]);
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
            return Promise.all([ load, L.resolveDefault(callUciChanges(), null) ]).then(function(data) {
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
                    ? _('Last %s ago, %d IPs queued').format(formatTime(geoLastRun), geoStats.geolocation.pending_ips || 0)
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
                                    ui.addNotification(null, E('p', {}, _('Failed to start geolocation process: ') + errorText(err)), 'error');
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
            var name = uci.get('geomate', section_id, 'name');
            return name ? _('Filter %h').format(name) : _('New filter');
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

        // Tooltip of the status and regions columns for a hand-written 'option allowed_region'
        var optionNote = _('Written as "option allowed_region" instead of "list allowed_region": the service start skips it and the map cannot show it.');

        // Status column - what the running service does with the filter. Staged changes are not
        // active before Save & Apply, and the service sees only what that has committed. A word
        // that needs a reason gets it as a tooltip
        o = s.option(form.DummyValue, '_status', _('Status'));
        o.modalonly = false;
        o.textvalue = function(section_id) {
            var filterName = uci.get('geomate', section_id, 'name');
            var enabled = uci.get('geomate', section_id, 'enabled') === '1';
            // The checks below read staged values: a staged change of the global switch
            // (service disabled) is unsaved for every enabled filter too
            var staged = isPending(section_id) || (enabled && isPending('global', 'enabled'));
            var words = [], notes = [];
            var problem = function(word, note) {
                words.push(word);
                if (note) notes.push(note);
            };

            if (!filterName) return '–';
            if (!enabled && !staged) return _('Disabled');

            if (staged) words.push(_('Unsaved'));
            if (enabled) {
                // The service does not start while Geomate is disabled globally
                if (uci.get('geomate', 'global', 'enabled') !== '1') problem(_('Service off'), _('Geomate is disabled in the global settings.'));
                if (hasNftError(filterName)) problem(_('nftables error'), _('See /tmp/geomate_nft_errors.log on the router.'));
                if (regionIsOption(section_id)) problem(_('Region not a list'), optionNote);
                else if (!regionList(section_id).some(function(r) { return parseRegion(r) !== null; })) problem(_('No regions'));
                if (!uci.get('geomate', section_id, 'ip_list')) problem(_('No IP list'));
            }

            if (!words.length) return _('Active');
            return E('span', notes.length ? { 'title': notes.join('\n') } : {}, [ words.join(', ') ]);
        };

        // Match column - the traffic the filter looks at (the options are edited in the dialog)
        o = s.option(form.DummyValue, '_match', _('Match'));
        o.modalonly = false;
        o.textvalue = function(section_id) {
            return E('span', {}, [ matchText(section_id) ]);
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
                return E('span', { 'title': _('At least %d geolocated IPs are no longer in the list.').format(geo - total - 1) },
                    [ _('%d (stale)').format(total) ]);
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

            if (regionIsOption(section_id)) return E('span', { 'title': optionNote }, [ _('Not a list') ]);
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

        // Source IP: the devices the filter applies to, like the field "Source address" of
        // LuCI's firewall. Several entries and exceptions need a backend that reports
        // src_ip_multi; with any other one the field takes one address, as before. Written as
        // one option with the entries separated by a space, never as a UCI list. No datatype:
        // LuCI checks it before validate, and a saved value it rejects would block every save
        // of the dialog
        var multi = hasCapability('src_ip_multi');
        o = s.option(multi ? SrcIpList : form.Value, 'src_ip', _('Source IP'),
            (multi ? _('Devices this filter applies to. Empty: all devices. Put ! before an address to leave it out.')
                : _('Device this filter applies to. Empty: all devices.')) + ' ' +
            _('Use a static lease so the address stays the same.'));
        o.placeholder = multi ? _('-- add IP --') : _('any');
        o.rmempty = true;
        o.modalonly = true;
        hosts.keys.forEach(function(ip) { o.value(ip, hosts.labels[ip]); });
        // A saved value that is no suggestion: the combobox adds it to the shared keylist, which
        // would list it in the dialog of every other filter
        o.transformChoices = function() {
            if (this.keylist)
                this.keylist.length = this.vallist.length;
            return form.Value.prototype.transformChoices.call(this);
        };
        // The entries of an option or of a hand-written list, as one string or as an array
        o.load = function(section_id) {
            var v = srcIpEntries(form.Value.prototype.load.call(this, section_id));
            return !v.length ? null : multi ? v : v.join(' ');
        };
        o.write = function(section_id, value) {
            return form.Value.prototype.write.call(this, section_id, srcIpEntries(value).join(' '));
        };
        // Text typed without Enter counts too
        o.parse = function(section_id) {
            takeTypedEntry(this.getUIElement(section_id));
            return form.Value.prototype.parse.call(this, section_id);
        };
        // value '' is the check of the widget as a whole, any other value the text typed into
        // its input
        o.validate = function(section_id, value) {
            return checkSrcIp((value == null || value === '') ? this.formvalue(section_id) : value,
                this.cfgvalue(section_id), multi);
        };

        // Source port configuration
        o = s.option(form.Value, 'src_port', _('Source Port'));
        o.datatype = 'list(neg(portrange))';
        o.placeholder = _('25200 25300 or 27015-27020');
        o.modalonly = true;

        // Destination port configuration
        o = s.option(form.Value, 'dest_port', _('Destination Port'));
        o.datatype = 'list(neg(portrange))';
        o.placeholder = _('25200 25300 or 27015-27020');
        o.modalonly = true;

        // Whitelist for specific IP addresses
        o = s.option(form.DynamicList, 'allowed_ip', _('Allowed IPs'));
        o.datatype = 'list(neg(ip4addr))';
        o.placeholder = _('1.2.3.4 or 1.2.3.0/24');
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
            dom.content(this.status, [ _('Geomate creates a missing file at its next start.') ]);
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
