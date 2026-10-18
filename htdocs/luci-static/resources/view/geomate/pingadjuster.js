'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';
'require rpc';
'require poll';

// Ping Adjuster: adds delay (and, if wanted, jitter and packet loss) to chosen devices' traffic with the kernel's
// netem queue. The rules live in /etc/config/ping_adjuster; saving them reloads the ping_adjuster service, whose
// script (/usr/libexec/ping-adjuster) sets everything up.

var PA_SCRIPT = '/usr/libexec/ping-adjuster';

// The packages the router still needs (tc-tiny, kmod-sched-core, kmod-ifb, kmod-netem), as the script reports them
function missingPackages(st) {
    if (Array.isArray(st.missing)) return st.missing;
    var m = [];   // (an older script only reports these three)
    if (!st.tc) m.push('tc-tiny');
    if (!st.ifb) m.push('kmod-ifb');
    if (!st.netem) m.push('kmod-netem');
    return m;
}

// The same install as the Install button, as one command for SSH
function sshCommand(pm, pkgs) {
    return (pm === 'apk' ? 'apk update && apk add %s' : 'opkg update && opkg install %s').format(pkgs.join(' ')) +
        ' && /etc/init.d/ping_adjuster restart';
}

// Why an install didn't work, in plain words
function installProblem(inst) {
    switch (inst && inst.error) {
    case 'lists':
        return _('The router couldn’t download the package lists. Check that it’s connected to the internet, then try again.');
    case 'space':
        return _('The router ran out of storage space while installing.');
    case 'nopm':
        return _('This router has no package manager (opkg or apk), so the packages can’t be installed from here.');
    case 'stopped':
        return _('The install stopped before it finished. Try again.');
    default:
        return _('These could not be installed: %s. The details say why. (On a development “snapshot” firmware, kernel packages often don’t fit the running kernel.)').format((inst && inst.failed) || '');
    }
}

var callDHCPLeases = rpc.declare({
    object: 'luci-rpc',
    method: 'getDHCPLeases',
    expect: { '': {} }
});

function getStatus() {
    return fs.exec_direct(PA_SCRIPT, ['status'], 'json').catch(function() { return null; });
}

// "192.168.1.50 192.168.1.60": IPv4 addresses (or ranges like 192.168.1.0/24), separated by spaces
function checkAddresses(value) {
    var list = String(value || '').trim().split(/[\s,]+/).filter(Boolean);
    if (!list.length) return _('Pick a device or type its address');
    for (var i = 0; i < list.length; i++) {
        var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(\d{1,2}))?$/.exec(list[i]);
        if (!m || [m[1], m[2], m[3], m[4]].some(function(x) { return +x > 255; }) || (m[6] && +m[6] > 32))
            return _('%s is not an IPv4 address').format(list[i]);
    }
    return true;
}

function fmtCount(n) { return n == null ? '0' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

return view.extend({
    load: function() {
        // the status call first: on a first visit it also makes the settings file the form needs
        return getStatus().then(function(st) {
            return Promise.all([
                uci.load('ping_adjuster').catch(function() { return null; }),
                callDHCPLeases().catch(function() { return {}; }),
                st
            ]);
        });
    },

    // The Install button: the router installs the missing packages in the background; the regular status updates show
    // how far it got
    handleInstall: function(ev) {
        var self = this;
        self.installing = true;
        self.installError = null;
        return fs.exec_direct(PA_SCRIPT, ['install'], 'json').then(function(res) {
            if (res && res.started === false && res.error === 'nopm')
                self.installError = installProblem({ error: 'nopm' });
        }).catch(function(err) {
            self.installError = (err && err.name === 'PermissionError')
                ? _('Your login is not allowed to install packages. Log in as root and try again.')
                : _('The install could not be started: %s').format((err && err.message) || String(err));
        }).then(function() {
            return getStatus().then(function(st) { self.renderNotes(st); self.renderLive(st); });
        });
    },

    // The box at the top: what is missing (with the Install button), problems of the last apply, and a warning about
    // flow offloading
    renderNotes: function(st) {
        var self = this, box = self.notesBox;   // (kept, so the first status shows before the page is on screen)
        if (!box) return;
        var inst = st && st.install, missing = st ? missingPackages(st) : [];
        // (rebuilt only when something in it changed: a rebuild at every status update would close "Details" and undo a
        // text selection in the SSH command)
        var key = JSON.stringify([st ? [missing, st.pm, inst, st.offload, st.errors, st.enabled] : null,
            !!self.installing, self.installError || null]);
        if (key === self.notesKey) return;
        self.notesKey = key;
        var items = [];
        if (!st) {
            items.push(E('div', { 'class': 'pa-note pa-bad' }, _('The Ping Adjuster script is missing. Run the Geomate installer again.')));
        } else {
            if (inst && inst.state === 'running') {
                items.push(E('div', { 'class': 'pa-note pa-busy' }, [
                    E('strong', { 'class': 'pa-spin' }, _('Installing the Ping Adjuster’s packages…')),
                    E('div', {}, (!inst.step || inst.step === 'lists') ? _('Getting the package lists…') : _('Installing %s…').format(inst.step)),
                    E('div', { 'class': 'pa-small' }, _('This can take a minute or two. It keeps going if you leave this page.'))
                ]));
            } else if (missing.length) {
                var failed = self.installing && inst && inst.state === 'failed';
                var parts = [E('strong', {}, _('The Ping Adjuster needs a few packages this router doesn’t have yet: %s.').format(missing.join(', ')))];
                if (failed) {
                    parts.push(E('div', { 'class': 'pa-problem' }, installProblem(inst)));
                    if (inst.log && inst.log.length)
                        parts.push(E('details', {}, [E('summary', {}, _('Details')), E('pre', {}, inst.log.join('\n'))]));
                }
                if (self.installError)
                    parts.push(E('div', { 'class': 'pa-problem' }, self.installError));
                if (st.pm) {
                    parts.push(E('div', { 'class': 'pa-actions' }, [
                        E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(self, 'handleInstall') },
                            failed ? _('Try again') : _('Install them')),
                        E('span', { 'class': 'pa-small' }, _('The router downloads and installs them, then starts the Ping Adjuster.'))
                    ]));
                    parts.push(E('details', {}, [
                        E('summary', {}, _('Or install them over SSH')),
                        E('code', {}, sshCommand(st.pm, missing))
                    ]));
                } else {
                    parts.push(E('div', {}, installProblem({ error: 'nopm' })));
                }
                items.push(E('div', { 'class': 'pa-note pa-bad' }, parts));
            } else if (self.installing && inst && inst.state === 'done') {
                items.push(E('div', { 'class': 'pa-note pa-good' }, [
                    E('strong', {}, _('Installed.')), ' ', _('The Ping Adjuster has everything it needs.')
                ]));
            }
            if (st.offload && st.offload !== 'off') {
                items.push(E('div', { 'class': 'pa-note pa-warn' }, [
                    E('strong', {}, st.offload === 'hardware' ? _('Hardware flow offloading is on.') : _('Software flow offloading is on.')),
                    ' ',
                    _('Offloaded connections skip the router’s queues, so the added ping can stop working partway through a match. Turn it off under Network → Firewall (Routing/NAT Offloading). On GL.iNet routers, also turn off network (hardware) acceleration in the GL.iNet admin panel.')
                ]));
            }
            (st.errors || []).forEach(function(e) {
                items.push(E('div', { 'class': 'pa-note pa-warn' }, e));
            });
            if (st.enabled === false)
                items.push(E('div', { 'class': 'pa-note' }, _('Ping Adjuster is switched off: no delay is added.')));
        }
        box.innerHTML = '';
        items.forEach(function(el) { box.appendChild(el); });
        box.style.display = items.length ? '' : 'none';
    },

    // Live numbers in the rules table
    renderLive: function(st) {
        var self = this, rules = (st && st.rules) || [];
        uci.sections('ping_adjuster', 'rule').forEach(function(s, i) {
            var id = 'pa-live-' + s['.name'];
            var cell = document.getElementById(id) || (self.root && self.root.querySelector('[id="' + id + '"]'));
            if (!cell) return;
            var r = rules.filter(function(x) { return x.index === i + 1; })[0];
            cell.innerHTML = '';
            if (!r || !r.active) {
                cell.appendChild(E('span', { 'class': 'pa-off' }, s.enabled === '0' ? _('Off') : _('Not active')));
                return;
            }
            var parts = [E('span', { 'class': 'pa-on' }, '● ' + _('Active'))];
            if (r.upload) parts.push(E('div', { 'class': 'pa-small' }, _('Up: %s packets').format(fmtCount(r.upload.packets)) + (r.upload.dropped ? _(', %s lost').format(fmtCount(r.upload.dropped)) : '')));
            if (r.download) parts.push(E('div', { 'class': 'pa-small' }, _('Down: %s packets').format(fmtCount(r.download.packets)) + (r.download.dropped ? _(', %s lost').format(fmtCount(r.download.dropped)) : '')));
            parts.forEach(function(p) { cell.appendChild(p); });
        });
    },

    render: function(data) {
        var self = this;
        var leases = (data[1] && data[1].dhcp_leases) || [];
        var m, s, o;

        if (!uci.get('ping_adjuster', 'global')) {
            uci.add('ping_adjuster', 'global', 'global');
            uci.set('ping_adjuster', 'global', 'enabled', '1');
        }

        m = new form.Map('ping_adjuster', _('Ping Adjuster'),
            _('Adds delay to a device’s connection, for example to give a console the same ping as your friends, or to test how a game plays on a slower connection. ' +
              'It can only add ping, never lower it. The delay is added on the router with the kernel’s netem queue, and only to IPv4 traffic that goes through the router to the internet.'));

        s = m.section(form.NamedSection, 'global', 'global');
        s.anonymous = true;
        o = s.option(form.Flag, 'enabled', _('Enable Ping Adjuster'),
            _('Switches every rule below on or off at once.'));
        o.rmempty = false;
        o.default = '1';

        s = m.section(form.GridSection, 'rule', _('Rules'),
            _('One rule per device or group of devices. The added ping is split between upload and download, so a game’s ping goes up by about the number you set.'));
        s.anonymous = true;
        s.addremove = true;
        s.sortable = true;
        s.nodescriptions = true;
        s.addbtntitle = _('Add rule');

        o = s.option(form.Flag, 'enabled', _('Enable'));
        o.editable = true;
        o.rmempty = false;
        o.default = '1';

        o = s.option(form.Value, 'name', _('Name'));
        o.placeholder = _('Console');

        o = s.option(form.Value, 'src_ip', _('Device'),
            _('The device(s) to slow down: pick one, or type addresses separated by spaces.'));
        leases.forEach(function(l) {
            if (l.ipaddr) o.value(l.ipaddr, l.hostname ? '%s (%s)'.format(l.ipaddr, l.hostname) : l.ipaddr);
        });
        o.validate = function(section_id, value) { return checkAddresses(value); };
        o.rmempty = false;

        o = s.option(form.Value, 'delay', _('Added ping (ms)'),
            _('How much higher the ping gets, in milliseconds.'));
        o.datatype = 'range(0,2000)';
        o.placeholder = '0';
        o.default = '20';
        o.rmempty = false;

        o = s.option(form.Value, 'jitter', _('Jitter (ms)'),
            _('Optional: lets the delay vary by up to this much, like an unsteady connection. Packets stay in order.'));
        o.datatype = 'range(0,1000)';
        o.placeholder = '0';

        o = s.option(form.Value, 'loss', _('Packet loss (%)'),
            _('Optional: drops this share of the packets, like a bad connection. Use with care: games quickly feel broken above 1-2 %.'));
        o.datatype = 'range(0,100)';
        o.placeholder = '0';

        o = s.option(form.ListValue, 'direction', _('Direction'),
            _('Both ways splits the added ping evenly between upload and download.'));
        o.value('both', _('Both ways'));
        o.value('upload', _('Upload only'));
        o.value('download', _('Download only'));
        o.default = 'both';

        o = s.option(form.ListValue, 'traffic', _('Traffic'),
            _('Game traffic: UDP to and from game server ports 1024 and up (the same traffic as the Any Game filter), so web pages, downloads and voice apps on port 443 are not slowed down. All traffic: everything the device sends and receives through the router.'));
        o.value('game', _('Game traffic'));
        o.value('all', _('All traffic'));
        o.default = 'game';

        o = s.option(form.DummyValue, '_live', _('Status'));
        o.modalonly = false;
        o.textvalue = function(section_id) {
            return E('div', { 'id': 'pa-live-' + section_id, 'class': 'pa-live' }, '…');
        };

        return m.render().then(function(rendered) {
            rendered.classList.add('geomate-dark-theme');
            var old = document.getElementById('geomate-pa-theme-style');
            if (old && old.parentNode) old.parentNode.removeChild(old);
            document.head.appendChild(E('style', { id: 'geomate-pa-theme-style' }, `
/* Geomate dark theme for the Ping Adjuster page (presentation only) */
.geomate-dark-theme{--gm-panel:#17232d;--gm-border:#30414d;--gm-text:#eaf1f5;--gm-muted:#9eafb9;--gm-accent:#9bdc28;color:var(--gm-text)}
.geomate-dark-theme .cbi-section,.geomate-dark-theme .cbi-section-node{background:var(--gm-panel)!important;color:var(--gm-text)!important;border:1px solid var(--gm-border)!important;border-radius:10px!important;padding:16px!important;margin:12px 0 18px!important;box-shadow:0 6px 20px rgba(0,0,0,.16)}
.geomate-dark-theme .cbi-section h3,.geomate-dark-theme .cbi-section .cbi-section-title{color:var(--gm-text)!important;font-weight:700;letter-spacing:.02em}
.geomate-dark-theme .cbi-value-title,.geomate-dark-theme label,.geomate-dark-theme .cbi-section p,.geomate-dark-theme .cbi-section em,.geomate-dark-theme .cbi-section strong{color:var(--gm-text)}
.geomate-dark-theme .cbi-value-description,.geomate-dark-theme .description,.geomate-dark-theme .cbi-map-descr,.geomate-dark-theme .cbi-section-descr{color:var(--gm-muted)!important}
.geomate-dark-theme input,.geomate-dark-theme select,.geomate-dark-theme textarea{background:#0f1921!important;color:var(--gm-text)!important;border:1px solid #3a4d59!important;border-radius:6px!important}
.geomate-dark-theme input:focus,.geomate-dark-theme select:focus,.geomate-dark-theme textarea:focus{border-color:var(--gm-accent)!important;box-shadow:0 0 0 2px rgba(155,220,40,.14)!important}
.geomate-dark-theme .cbi-button,.geomate-dark-theme button{border-radius:6px!important}
.geomate-dark-theme .cbi-button-positive,.geomate-dark-theme .cbi-button-action{background:var(--gm-accent)!important;color:#111b12!important;border-color:var(--gm-accent)!important;font-weight:750}
.geomate-dark-theme th{background:#263944!important;color:#eaf1f5!important}
.geomate-dark-theme td,.geomate-dark-theme th{border-color:#30414d!important}
.geomate-dark-theme .cbi-tblsection [data-name="src_ip"]{min-width:150px}
#pa-notes{margin:0 0 12px}
.pa-note{border:1px solid #30414d;border-left:4px solid #9eafb9;background:#17232d;color:#eaf1f5;border-radius:8px;padding:10px 12px;margin:0 0 8px;line-height:1.5}
.pa-note.pa-bad{border-left-color:#ef4444}
.pa-note.pa-warn{border-left-color:#fbbf24}
.pa-note.pa-good{border-left-color:#4ade80}
.pa-note.pa-busy{border-left-color:#38bdf8}
.pa-note .pa-problem{margin:6px 0;color:#fca5a5}
.pa-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:8px 0 4px}
.pa-note details{margin-top:6px}
.pa-note summary{cursor:pointer;color:#9eafb9}
.pa-spin::before{content:'';display:inline-block;width:11px;height:11px;margin-right:8px;vertical-align:-1px;border:2px solid #38bdf8;border-right-color:transparent;border-radius:50%;animation:pa-spin .8s linear infinite}
@keyframes pa-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.pa-spin::before{animation:none;border-right-color:#38bdf8}}
.pa-note pre{margin:6px 0 0;padding:6px 8px;background:#0f1921;border:1px solid #30414d;border-radius:6px;color:#cfe0ea;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto}
.pa-note code{display:block;margin:6px 0;padding:6px 8px;background:#0f1921;border:1px solid #30414d;border-radius:6px;color:#cfe0ea;white-space:pre-wrap;word-break:break-all;user-select:all}
.pa-small{font-size:12px;color:#9eafb9}
.pa-on{color:#4ade80;font-weight:600;white-space:nowrap}
.pa-off{color:#9eafb9;white-space:nowrap}
`));
            self.root = rendered;
            self.notesBox = E('div', { 'id': 'pa-notes', 'style': 'display:none' });
            rendered.insertBefore(self.notesBox, rendered.firstChild);
            self.renderNotes(data[2]);
            self.renderLive(data[2]);
            poll.add(function() {
                if (!document.getElementById('pa-notes')) return;
                return getStatus().then(function(st) { self.renderNotes(st); self.renderLive(st); });
            }, 3);
            return rendered;
        });
    }
});
