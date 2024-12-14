'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require rpc';
'require poll';
'require fs';

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

return view.extend({
    geoFilters: {},
    map: null,
    currentConnectionsData: [],
    allowedIPsData: [],
    unlocatedIPs: [],

    // Load initial data required for the view
    load: function() {
        return Promise.all([
            uci.load('geomate'),
            callGeomateConnections(),
            callGeomateAllowedIPs(),
            getServiceStatus()
        ]).then(function(data) {
            var geomateConfig = data[0];
            var connectionsResult = data[1];
            var allowedIPsResult = data[2];
            var serviceStatus = data[3];
    
            this.currentConnectionsData = connectionsResult.connections || [];
            this.allowedIPsData = allowedIPsResult.allowed_ips || [];
            this.serviceStatus = serviceStatus; // Store the service status
    
            console.log('Initial connectionsData:', this.currentConnectionsData);
            console.log('Initial allowedIPsData:', this.allowedIPsData);
            console.log('Service Status:', this.serviceStatus);
    
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
        var originalMapHeight = null;

        m = new form.Map('geomate', '', '');

        // Section to display the current status of the Geomate service
        s = m.section(form.TypedSection, '_service_status', _('Service Status'));
        s.anonymous = true;
        s.render = function() {
            var statusColor = self.serviceStatus === 'Running' ? 'green' : 'red';
            var statusText = self.serviceStatus === 'Running' ? _('Running') : _('Not Running');
        
            return E('div', { style: 'display: flex; align-items: center; margin-left: 8px;' }, [
                // Colored circle indicating service status
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
                // Text displaying the service status
                E('p', { id: 'service-status-text', style: 'margin: 0;' }, _('Service Status: ') + statusText)
            ]);
        };

        // Section to embed the map interface
        s = m.section(form.TypedSection, '_map', _('Map'));
        s.anonymous = true;
        s.render = function() {
            return E('div', { id: 'geomate-map-container', style: 'position: relative;' }, [
                E('iframe', {
                    src: L.resource('view/geomate/map.html'),
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
                if (event.data.type === 'mapReady') {
                    console.log('Map is ready, loading data');
                    self.loadGeoFilters()
                        .then(() => {
                            self.sendAllowedIPsToMap(self.allowedIPsData || []);
                            self.sendConnectionsToMap(self.currentConnectionsData || []);
                            self.updateActiveConnectionsList();
                        });
                }
            }, false);

            // Regularly update the service status
            poll.add(function() {
                return getServiceStatus().then(function(serviceStatus) {
                    self.serviceStatus = serviceStatus;
                    var statusElement = document.getElementById('service-status-text');
                    var indicatorElement = document.getElementById('service-status-indicator');

                    if (statusElement) {
                        var statusText = serviceStatus === 'Running' ? _('Running') : _('Not Running');
                        statusElement.textContent = _('Service Status: ') + statusText;
                    }

                    if (indicatorElement) {
                        var statusColor = serviceStatus === 'Running' ? 'green' : 'red';
                        indicatorElement.style.backgroundColor = statusColor;
                    }
                });
            }, 5); // Update every 5 seconds

            // Polling to fetch connections and allowed IPs every 2 seconds
            poll.add(function() {
                return Promise.all([
                    callGeomateConnections(),
                    callGeomateAllowedIPs()
                ]).then(function(results) {
                    var connectionsData = results[0].connections || [];
                    var allowedIPsData = results[1].allowed_ips || [];
                    self.currentConnectionsData = connectionsData;
                    self.allowedIPsData = allowedIPsData;
                    console.log('Polled connectionsData:', connectionsData);
                    console.log('Polled allowedIPsData:', allowedIPsData);
                    self.sendConnectionsToMap(connectionsData);
                    self.sendAllowedIPsToMap(allowedIPsData);
                    self.updateActiveConnectionsList();
                }).catch(function(error) {
                    console.error('Error fetching data:', error);
                });
            }, 2); // Interval in seconds

            return rendered;
        });
    },

    // Set up handlers for messages received from the map iframe
    setupMessageHandlers: function() {
        var self = this;
        window.addEventListener('message', function(event) {
            console.log('Received message from iframe:', event.data);
            if (event.data.type === 'mapReady') {
                console.log('Map is ready, loading geo filters');
                self.loadGeoFilters()
                    .then(() => {
                        self.sendConnectionsToMap(self.currentConnectionsData || []);
                        self.sendAllowedIPsToMap(self.allowedIPsData || []);
                        self.updateActiveConnectionsList();
                    });
            } else if (event.data.type === 'regionCreated') {
                console.log('New geo filter:', event.data.data);
                self.updateGeoFilter(event.data.data.name, null, event.data.data.region, true);
            } else if (event.data.type === 'regionEdited') {
                console.log('Updating geo filter:', event.data.data);
                var data = event.data.data;
                self.updateGeoFilter(data.name, data.oldRegion, data.region, false);
            } else if (event.data.type === 'regionDeleted') {
                console.log('Deleting geo filter:', event.data.data.name, event.data.data.region);
                self.deleteGeoFilter(event.data.data.name, event.data.data.region)
                    .then(() => {
                        return self.loadGeoFilters();
                    })
                    .catch(error => {
                        console.error('Error deleting region:', error);
                    });
            } else if (event.data.type === 'unlocatedIPs') {
                console.log('Received unlocated IPs:', event.data.data);
                self.unlocatedIPs = event.data.data;
                self.updateUnlocatedIPsList();
            }
        }, false);
    },

    // Send the current connections data to the map iframe
    sendConnectionsToMap: function(connections) {
        console.log('Sending connections to the map:', connections);
        var iframe = document.querySelector('#geomate-map-container iframe');
        if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage({ type: 'updateConnections', data: connections }, '*');
        } else {
            console.error('Iframe not found or contentWindow is not available');
        }
    },

    // Send the allowed IPs data to the map iframe
    sendAllowedIPsToMap: function(allowedIPs) {
        console.log('Sending Allowed IPs to the map:', allowedIPs);
        var iframe = document.querySelector('#geomate-map-container iframe');
        if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage({ type: 'updateAllowedIPs', data: allowedIPs }, '*');
        } else {
            console.error('Iframe not found or contentWindow is not available');
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
                        regions.forEach(region => {
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
    updateGeoFilter: function(name, oldRegion, newRegion, isNewRegion) {
        var self = this;
    
        if (isNewRegion) {
            // Get existing filter settings if available
            var existingSettings = null;
            var sections = uci.sections('geomate', 'geo_filter');
            var existingSection = sections.find(section => section.name === name);
            
            if (existingSection) {
                existingSettings = {
                    protocol: existingSection.protocol || 'udp',
                    src_ip: existingSection.src_ip || '',
                    src_port: existingSection.src_port || '',
                    dest_port: existingSection.dest_port || '',
                    allowed_ip: existingSection.allowed_ip || [],
                    ip_list: existingSection.ip_list || ''
                };
            }

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
                            // Protocol
                            E('div', { 'class': 'cbi-value' }, [
                                E('label', { 'class': 'cbi-value-title', 'style': 'width:33%' }, _('Protocol')),
                                E('div', { 'class': 'cbi-value-field', 'style': 'margin-left:33%' }, [
                                    E('select', { 
                                        'id': 'geomate-protocol',
                                        'class': 'cbi-input-select',
                                        'value': existingSettings ? existingSettings.protocol : 'udp'
                                    }, [
                                        E('option', { 'value': 'tcp', 'selected': existingSettings && existingSettings.protocol === 'tcp' }, 'TCP'),
                                        E('option', { 'value': 'udp', 'selected': !existingSettings || existingSettings.protocol === 'udp' }, 'UDP')
                                    ])
                                ])
                            ]),
                            // Source IP
                            E('div', { 'class': 'cbi-value' }, [
                                E('label', { 'class': 'cbi-value-title', 'style': 'width:33%' }, _('Source IP')),
                                E('div', { 'class': 'cbi-value-field', 'style': 'margin-left:33%' }, [
                                    new ui.Textfield(existingSettings ? existingSettings.src_ip : '', {
                                        id: 'geomate-src-ip',
                                        name: 'src_ip',
                                        placeholder: '192.168.1.0/24',
                                        datatype: 'ip4addr',
                                        optional: true
                                    }).render()
                                ])
                            ]),
                            // Source Port
                            E('div', { 'class': 'cbi-value' }, [
                                E('label', { 'class': 'cbi-value-title', 'style': 'width:33%' }, _('Source Port')),
                                E('div', { 'class': 'cbi-value-field', 'style': 'margin-left:33%' }, [
                                    new ui.Textfield(existingSettings ? existingSettings.src_port : '', {
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
                                    new ui.Textfield(existingSettings ? existingSettings.dest_port : '', {
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
                                        'value': existingSettings ? existingSettings.ip_list : '',
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
                            var settings = {
                                protocol: document.getElementById('geomate-protocol').value,
                                src_ip: document.querySelector('input[name="src_ip"]').value,
                                src_port: document.querySelector('input[name="src_port"]').value,
                                dest_port: document.querySelector('input[name="dest_port"]').value,
                                allowed_ip: dynlist.getValue(),
                                ip_list: document.getElementById('geomate-ip-list').value
                            };
    
                            ui.hideModal();
                            self.saveGeoFilter(name, newRegion, settings);
                        }
                    }, _('Save'))
                ])
            ]);

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
                            uci.set('geomate', existingSection['.name'], 'allowed_region', regions);
                            return uci.save();
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
        return this.map.reset()
            .then(() => {
                this.sendMessageToMap('clearMap');
                this.loadGeoFilters();
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
    
        connections.forEach(function(conn) {
            var geoFilterName = conn.filter_name || _('Unknown');
            var status = _('Unknown');
    
            // Determine the status based on connection data
            if (conn.is_allowed_ip) {
                status = _('Allowed (Whitelist)');
            } else if (conn.allowed === true) {
                status = _('Allowed');
            } else if ((!conn.geo || !conn.geo.lat || !conn.geo.lon) && (conn.allowed === false || typeof conn.allowed === 'undefined')) {
                status = _('Untracked');
            } else if (conn.allowed === false) {
                status = _('Blocked');
            } else {
                status = _('Unknown');
            }
    
            // Extract the destination IP address
            var destIP = conn.dst || _('Unknown');
    
            // Create a table row with the connection details
            var tr = E('tr', {}, [
                E('td', {}, destIP),         // Destination IP
                E('td', {}, geoFilterName),  // Name of the Geo-Filter
                E('td', {}, status)          // Connection status
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
    }
});
