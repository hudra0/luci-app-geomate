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
            } else if (event.data.type === 'regionCreated' || event.data.type === 'regionEdited') {
                console.log('Updating geo filter:', event.data.data);
                self.updateGeoFilter(event.data.data.name, event.data.data.region, event.data.type === 'regionCreated');
            } else if (event.data.type === 'regionDeleted') {
                console.log('Deleting geo filter:', event.data.data.name, event.data.data.region);
                self.deleteGeoFilter(event.data.data.name, event.data.data.region);
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
    updateGeoFilter: function(name, region, isNewRegion) {
        console.log('Updating UCI config for:', name, region, 'Is new region:', isNewRegion);
        
        return uci.load('geomate')
            .then(() => {
                var sections = uci.sections('geomate', 'geo_filter');
                var existingSection = sections.find(section => section.name === name);
                
                if (existingSection) {
                    var regionsList = existingSection.allowed_region || [];
                    if (!Array.isArray(regionsList)) {
                        regionsList = [regionsList];
                    }
                    
                    if (isNewRegion) {
                        // Add the new region to the existing filter
                        regionsList.push(region);
                        console.log('Added new region to existing filter:', name);
                    } else {
                        // Update the existing region or add it if it does not exist
                        var existingRegionIndex = regionsList.findIndex(r => r.startsWith(region.split(':')[0]));
                        if (existingRegionIndex !== -1) {
                            regionsList[existingRegionIndex] = region;
                            console.log('Updated existing region in filter:', name);
                        } else {
                            regionsList.push(region);
                            console.log('Added new region to existing filter:', name);
                        }
                    }
                    
                    uci.set('geomate', existingSection['.name'], 'allowed_region', regionsList);
                    uci.set('geomate', existingSection['.name'], 'enabled', '1');
                } else {
                    // Create a new Geo-Filter section in UCI
                    var newSectionName = uci.add('geomate', 'geo_filter');
                    uci.set('geomate', newSectionName, 'name', name);
                    uci.set('geomate', newSectionName, 'allowed_region', [region]);
                    uci.set('geomate', newSectionName, 'enabled', '1');
                    console.log('Created new filter:', name);
                }
                
                console.log('UCI config updated for:', name);
                return uci.save('geomate');
            })
            .then(() => this.logUCIValues())
            .catch(error => {
                console.error('Error updating UCI config:', error);
                throw error;
            });
    },

    // Remove a Geo-Filter or a specific region from it
    deleteGeoFilter: function(name, region) {
        console.log('Removing region from UCI config:', name, region);
        return uci.load('geomate')
            .then(() => {
                var sections = uci.sections('geomate', 'geo_filter');
                var existingSection = sections.find(section => section.name === name);
                if (existingSection) {
                    // Get the existing allowed_region list
                    var regionsList = existingSection.allowed_region || [];
                    if (!Array.isArray(regionsList)) {
                        regionsList = [regionsList];
                    }
    
                    // Find and remove the specific region
                    var index = regionsList.indexOf(region);
                    if (index > -1) {
                        regionsList.splice(index, 1);
                        if (regionsList.length > 0) {
                            // Update the allowed_region list
                            uci.set('geomate', existingSection['.name'], 'allowed_region', regionsList);
                            // Ensure the geo filter remains enabled
                            uci.set('geomate', existingSection['.name'], 'enabled', '1');
                            console.log(`Region "${region}" removed from Geo-Filter "${name}". Remaining regions:`, regionsList);
                        } else {
                            // If no regions remain, disable the geo filter and remove allowed_region
                            uci.set('geomate', existingSection['.name'], 'enabled', '0');
                            uci.unset('geomate', existingSection['.name'], 'allowed_region');
                            console.log(`Last region "${region}" removed. Geo-Filter "${name}" is now disabled.`);
                        }
                        return uci.save('geomate');
                    } else {
                        console.warn(`Region "${region}" not found in Geo-Filter "${name}".`);
                    }
                } else {
                    console.warn(`Geo-Filter "${name}" not found.`);
                }
            })
            .then(() => this.logUCIValues())
            .catch(error => {
                console.error('Error deleting region from geo filter:', error);
                throw error;
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
    }    
});
