var mapView;

$(function() {

	var map = null;
	var draw = null;
	var geocoder = null;
	var bar = null;

	var cancellationToken = null;
	var requests = [];
	var requestSequence = 0;
	var currentDownload = null;
	var isDownloadActive = false;
	var downloadEnded = false;
	var isDownloadPaused = false;
	var resumeCallbacks = [];
	var TILE_BATCH_SIZE = 1000;
	var MAX_LOG_LINES = 1000;
	var PREVIEW_TILE_INTERVAL = 25;
	var MAX_GRID_PREVIEW_TILES = 5000;
	var continueDirectoryState = null;

	var chinaDarkSource = "https://rt0.map.gtimg.com/tile?z={z}&x={x}&y={tmsY}&styleid=4&scene=0&version=347";
	var chinaLightSource = "https://rt0.map.gtimg.com/tile?z={z}&x={x}&y={tmsY}&styleid=0&scene=0&version=347";
	var chinaPreviewSource = "https://rt0.map.gtimg.com/tile?z={z}&x={x}&y={y}&styleid=0&scene=0&version=347";
    var GeoQLightSource = "https://thematic.geoq.cn/arcgis/rest/services/ChinaOnlineStreetGray/MapServer/tile/{z}/{y}/{x}"
	var sources = {

		"Tencent Dark Chinese": chinaDarkSource,
        "Tencent Light Chinese": chinaLightSource,
        "GeoQ": GeoQLightSource,
		"div-0": "",

		"Bing Maps": "http://ecn.t0.tiles.virtualearth.net/tiles/r{quad}.jpeg?g=129&mkt=en&stl=H",
		"Bing Maps Satellite": "http://ecn.t0.tiles.virtualearth.net/tiles/a{quad}.jpeg?g=129&mkt=en&stl=H",
		"Bing Maps Hybrid": "http://ecn.t0.tiles.virtualearth.net/tiles/h{quad}.jpeg?g=129&mkt=en&stl=H",

		"div-1B": "",

		"Google Maps": "https://mt0.google.com/vt?lyrs=m&x={x}&s=&y={y}&z={z}",
		"Google Maps Satellite": "https://mt0.google.com/vt?lyrs=s&x={x}&s=&y={y}&z={z}",
		"Google Maps Hybrid": "https://mt0.google.com/vt?lyrs=h&x={x}&s=&y={y}&z={z}",
		"Google Maps Terrain": "https://mt0.google.com/vt?lyrs=p&x={x}&s=&y={y}&z={z}",

		"div-2": "",

		"Open Street Maps": "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
		"Open Cycle Maps": "http://a.tile.opencyclemap.org/cycle/{z}/{x}/{y}.png",

		"div-3": "",

		"ESRI World Imagery": "https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
		"Carto Light": "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",

	};

	function getTileScheme() {
		return $("#tile-scheme").val() || "xyz";
	}

	function refreshSelect(selector) {
		var select = $(selector);
		if(select.formSelect) {
			select.formSelect('destroy');
			select.formSelect();
		}
	}

	function getMapPreviewSource(url) {
		if(!url || url.indexOf("{quad}") >= 0) {
			return null;
		}

		var previewUrl = url;
		var scheme = "xyz";

		if(previewUrl.indexOf("{tmsY}") >= 0) {
			previewUrl = previewUrl.split("{tmsY}").join("{y}");
			scheme = "tms";
		} else if(previewUrl.indexOf("{xyzY}") >= 0) {
			previewUrl = previewUrl.split("{xyzY}").join("{y}");
			scheme = "xyz";
		}

		return {
			url: previewUrl,
			scheme: scheme
		};
	}

	function getFirstOverlayLayerId() {
		var style = map.getStyle();
		if(!style || !style.layers) {
			return null;
		}

		for(var i = 0; i < style.layers.length; i++) {
			var id = style.layers[i].id;
			if(id.indexOf("gl-draw-") == 0 || id == "grid-preview" || id.indexOf("temp-") == 0) {
				return id;
			}
		}

		return null;
	}

	function updateMapTileSource(url) {
		var previewSource = getMapPreviewSource(url);
		if(!previewSource) {
			M.toast({html: 'This tile source cannot be previewed on the map.', displayLength: 5000});
			return;
		}

		if(!map) {
			return;
		}

		if(!map.isStyleLoaded()) {
			map.once('load', function() {
				updateMapTileSource(url);
			});
			return;
		}

		if(map.getLayer('osm-tiles')) {
			map.removeLayer('osm-tiles');
		}
		if(map.getSource('osm')) {
			map.removeSource('osm');
		}

		map.addSource('osm', {
			type: 'raster',
			tiles: [previewSource.url],
			tileSize: 256,
			scheme: previewSource.scheme
		});

		var rasterLayer = {
			id: 'osm-tiles',
			type: 'raster',
			source: 'osm'
		};
		var firstOverlayLayerId = getFirstOverlayLayerId();

		if(firstOverlayLayerId) {
			map.addLayer(rasterLayer, firstOverlayLayerId);
		} else {
			map.addLayer(rasterLayer);
		}
	}

	function initializeMap() {

		// A Mapbox token is only required if you want the search/geocoder feature to work.
		// Get a free token at https://account.mapbox.com/ and replace the empty string below.
		mapboxgl.accessToken = '';
		var initialPreviewSource = getMapPreviewSource($("#source-box").val()) || {
			url: chinaPreviewSource,
			scheme: "tms"
		};

		map = new mapboxgl.Map({
			container: 'map-view',
			style: {
				version: 8,
				sources: {
					'osm': {
						type: 'raster',
						tiles: [initialPreviewSource.url],
						tileSize: 256,
						scheme: initialPreviewSource.scheme,
						attribution: 'Tencent Maps'
					}
				},
				layers: [{
					id: 'osm-tiles',
					type: 'raster',
					source: 'osm'
				}]
			},
			center: [118.7915619, 32.0615513],
			zoom: 12
		});

		if (mapboxgl.accessToken) {
			geocoder = new MapboxGeocoder({ accessToken: mapboxgl.accessToken });
			map.addControl(geocoder);
		}
	}

	function initializeMaterialize() {
		$('select').formSelect();
		$('.dropdown-trigger').dropdown({
			constrainWidth: false,
		});
	}

	function initializeSources() {

		var dropdown = $("#sources");

		for(var key in sources) {
			var url = sources[key];

			if(url == "") {
				dropdown.append("<hr/>");
				continue;
			}

			var item = $("<li><a></a></li>");
			item.attr("data-url", url);
			item.find("a").text(key);

			item.click(function() {
				var url = $(this).attr("data-url");
				$("#source-box").val(url);
				updateMapTileSource(url);
			})

			dropdown.append(item);
		}

		$("#source-box").change(function() {
			updateMapTileSource($(this).val());
		});
	}

	function initializeSearch() {
		$("#search-form").submit(function(e) {
			var location = $("#location-box").val();
			if (geocoder) geocoder.query(location);

			e.preventDefault();
		})
	}

	function initializeMoreOptions() {

		$("#more-options-toggle").click(function() {
			$("#more-options").toggle();
		})

		var outputFileBox = $("#output-file-box")

		function setContinueMode(enabled) {
			$("#continue-download-field").toggle(enabled);

			if(enabled) {
				$("#output-type").val("directory");
				outputFileBox.val("{z}/{x}/{y}.png");
				$("#output-type").prop("disabled", true);
				$("#output-directory-box").prop("disabled", true);
				$("#output-file-box").prop("disabled", true);
				$("#tile-scheme").prop("disabled", true);
				$("#output-scale").prop("disabled", true);
				refreshSelect("#output-type");
				refreshSelect("#tile-scheme");
				refreshSelect("#output-scale");
			} else {
				continueDirectoryState = null;
				$("#continue-download-path").val("");
				$("#output-type").prop("disabled", false);
				$("#output-directory-box").prop("disabled", false);
				$("#output-file-box").prop("disabled", false);
				$("#tile-scheme").prop("disabled", false);
				$("#output-scale").prop("disabled", false);
				refreshSelect("#output-type");
				refreshSelect("#tile-scheme");
				refreshSelect("#output-scale");
			}

			updateStitchCheckboxState();
		}

		function updateStitchCheckboxState() {
			var outputType = $("#output-type").val();
			if (outputType !== "directory") {
				$("#stitch-checkbox").prop("checked", false).prop("disabled", true);
			} else {
				$("#stitch-checkbox").prop("disabled", false);
			}
		}

		$("#output-type").change(function() {
			var outputType = $("#output-type").val();
			if(outputType == "mbtiles") {
				outputFileBox.val("tiles.mbtiles")
			} else if(outputType == "repo") {
				outputFileBox.val("tiles.repo")
			} else if(outputType == "directory") {
				outputFileBox.val("{z}/{x}/{y}.png")
			}
			updateStitchCheckboxState();
		})

		$("#continue-download-checkbox").change(function() {
			setContinueMode($(this).is(":checked"));
		})

		$("#continue-download-path").change(function() {
			loadContinueDirectoryPath($(this).val()).catch(function() {});
		})

		$("#choose-continue-directory-button").click(function() {
			chooseContinueDirectory();
		})

		updateStitchCheckboxState();

	}

	function applyDownloadedConfig(session) {
		if(session.bounds && session.bounds.length == 4) {
			setRectangleFromBounds(session.bounds[0], session.bounds[1], session.bounds[2], session.bounds[3], false);
		}

		if(session.minZoom !== undefined && session.minZoom !== null && !isNaN(parseInt(session.minZoom))) {
			$("#zoom-from-box").val(session.minZoom);
		}
		if(session.maxZoom !== undefined && session.maxZoom !== null && !isNaN(parseInt(session.maxZoom))) {
			$("#zoom-to-box").val(session.maxZoom);
		}
		if(session.source) {
			$("#source-box").val(session.source);
			updateMapTileSource(session.source);
		}
		if(session.outputFile) {
			$("#output-file-box").val(session.outputFile);
		}
		if(session.tileScheme) {
			$("#tile-scheme").val(session.tileScheme);
			refreshSelect("#tile-scheme");
		}
		if(session.outputScale) {
			$("#output-scale").val(session.outputScale.toString());
			refreshSelect("#output-scale");
		}

		M.updateTextFields();
	}

	function createContinueDirectoryFormData(path) {
		var data = new FormData();
		data.append('outputDirectory', path);
		return data;
	}

	async function loadContinueDirectoryPath(path) {
		path = (path || "").trim();
		if(!path) {
			continueDirectoryState = null;
			return;
		}

		continueDirectoryState = {
			directoryPath: path,
		};

		$("#output-directory-box").val(path);
		M.updateTextFields();

		try {
			var result = await $.ajax({
				url: "/continue-directory-config",
				async: true,
				timeout: 30 * 1000,
				type: "post",
				contentType: false,
				processData: false,
				data: createContinueDirectoryFormData(path),
				dataType: 'json',
			});

			continueDirectoryState = {
				directoryPath: result.outputDirectory || path,
			};
			$("#output-directory-box").val(continueDirectoryState.directoryPath);

			if(result.session) {
				applyDownloadedConfig(result.session);
			}

			if(result.configSource == "download-session.json") {
				M.toast({html: 'Loaded download-session.json from selected directory.', displayLength: 3000});
			} else if(result.configSource == "metadata.json") {
				M.toast({html: 'Loaded metadata.json from selected directory.', displayLength: 3000});
			} else {
				M.toast({html: 'No download-session.json or metadata.json found. Current form settings will be used.', displayLength: 7000});
			}
		} catch(error) {
			var message = getAjaxErrorMessage(error, "Could not read selected directory config.");
			M.toast({html: message, displayLength: 7000});
			continueDirectoryState = null;
			throw error;
		}
	}

	async function chooseContinueDirectory() {
		try {
			var result = await $.ajax({
				url: "/choose-continue-directory",
				async: true,
				timeout: 5 * 60 * 1000,
				type: "get",
				dataType: 'json',
			});

			if(!result.path) {
				return;
			}

			$("#continue-download-path").val(result.path);
			M.updateTextFields();
			await loadContinueDirectoryPath(result.path);
		} catch(error) {
			var message = getAjaxErrorMessage(error, "Could not choose downloaded directory.");
			M.toast({html: message, displayLength: 7000});
		}
	}

	function pollStitchStatus() {
		return new Promise(function(resolve) {
			var lastMessage = "";
			var interval = setInterval(function() {
				$.ajax({
					url: "/stitch-status",
					async: true,
					type: "get",
					dataType: 'json',
				}).done(function(status) {
					if (status.message !== lastMessage) {
						lastMessage = status.message;
						logItemRaw(status.message);
					}
					if (status.state === "done") {
						clearInterval(interval);
						for (var i = 0; i < status.files.length; i++) {
							logItemRaw("Saved: " + status.files[i]);
						}
						resolve();
					} else if (status.state === "error") {
						clearInterval(interval);
						resolve();
					}
				}).fail(function() {
					clearInterval(interval);
					logItemRaw("Could not reach stitch status endpoint.");
					resolve();
				});
			}, 2000);
		});
	}

	function initializeRectangleTool() {
		
		var modes = MapboxDraw.modes;
		modes.draw_rectangle = DrawRectangle.default;

		draw = new MapboxDraw({
			modes: modes
		});
		map.addControl(draw);

		map.on('draw.create', function (e) {
			M.Toast.dismissAll();
		});

		$("#rectangle-draw-button").click(function() {
			startDrawing();
		})

		$("#bounds-apply-button").click(function() {
			setRectangleFromBoundsInput();
		})

	}

	function startDrawing() {
		removeGrid();
		draw.deleteAll();
		draw.changeMode('draw_rectangle');

		M.Toast.dismissAll();
		M.toast({html: 'Click two points on the map to make a rectangle.', displayLength: 7000})
	}

	function parseBoundsInputValue(selector) {
		var value = parseFloat($(selector).val());
		if(isNaN(value)) {
			return null;
		}

		return value;
	}

	function setRectangleFromBounds(west, south, east, north, showToast) {
		if(west < -180 || west > 180 || east < -180 || east > 180 || south < -85.0511 || south > 85.0511 || north < -85.0511 || north > 85.0511) {
			M.toast({html: 'Bounds are outside the supported Web Mercator range.', displayLength: 5000})
			return;
		}

		if(west >= east || south >= north) {
			M.toast({html: 'West must be less than east, and south must be less than north.', displayLength: 5000})
			return;
		}

		removeGrid();
		$("#bounds-west-box").val(west);
		$("#bounds-south-box").val(south);
		$("#bounds-east-box").val(east);
		$("#bounds-north-box").val(north);
		M.updateTextFields();
		draw.deleteAll();
		draw.changeMode('simple_select');
		draw.add({
			type: 'Feature',
			properties: {},
			geometry: {
				type: 'Polygon',
				coordinates: [[
					[west, north],
					[east, north],
					[east, south],
					[west, south],
					[west, north]
				]]
			}
		});

		map.fitBounds([[west, south], [east, north]], {
			padding: 40
		});
		if(showToast !== false) {
			M.Toast.dismissAll();
			M.toast({html: 'Region bounds applied.', displayLength: 3000})
		}
	}

	function setRectangleFromBoundsInput() {
		var west = parseBoundsInputValue("#bounds-west-box");
		var south = parseBoundsInputValue("#bounds-south-box");
		var east = parseBoundsInputValue("#bounds-east-box");
		var north = parseBoundsInputValue("#bounds-north-box");

		if(west === null || south === null || east === null || north === null) {
			M.toast({html: 'Enter west, south, east, and north bounds.', displayLength: 5000})
			return;
		}

		setRectangleFromBounds(west, south, east, north, true);
	}

	function initializeGridPreview() {
		$("#grid-preview-button").click(previewGrid);

		map.on('click', showTilePopup);
	}

	function showTilePopup(e) {

		if(!e.originalEvent.ctrlKey) {
			return;
		}

		var maxZoom = getMaxZoom();

		var x = lat2tile(e.lngLat.lat, maxZoom);
		var y = long2tile(e.lngLat.lng, maxZoom);

		var content = "X, Y, Z<br/><b>" + x + ", " + y + ", " + maxZoom + "</b><hr/>";
		content += "Lat, Lng<br/><b>" + e.lngLat.lat + ", " + e.lngLat.lng + "</b>";

        new mapboxgl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(content)
            .addTo(map);

        console.log(e.lngLat)

	}

	function long2tile(lon,zoom) {
		return (Math.floor((lon+180)/360*Math.pow(2,zoom)));
	}

	function lat2tile(lat,zoom)  {
		return (Math.floor((1-Math.log(Math.tan(lat*Math.PI/180) + 1/Math.cos(lat*Math.PI/180))/Math.PI)/2 *Math.pow(2,zoom)));
	}

	function tile2long(x,z) {
		return (x/Math.pow(2,z)*360-180);
	}

	function tile2lat(y,z) {
		var n=Math.PI-2*Math.PI*y/Math.pow(2,z);
		return (180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n))));
	}

	function getTileRect(x, y, zoom) {

		var c1 = new mapboxgl.LngLat(tile2long(x, zoom), tile2lat(y, zoom));
		var c2 = new mapboxgl.LngLat(tile2long(x + 1, zoom), tile2lat(y + 1, zoom));

		return new mapboxgl.LngLatBounds(c1, c2);
	}

	function getMinZoom() {
		return Math.min(parseInt($("#zoom-from-box").val()), parseInt($("#zoom-to-box").val()));
	}

	function getMaxZoom() {
		return Math.max(parseInt($("#zoom-from-box").val()), parseInt($("#zoom-to-box").val()));
	}

	function getArrayByBounds(bounds) {

		var tileArray = [
			[ bounds.getSouthWest().lng, bounds.getNorthEast().lat ],
			[ bounds.getNorthEast().lng, bounds.getNorthEast().lat ],
			[ bounds.getNorthEast().lng, bounds.getSouthWest().lat ],
			[ bounds.getSouthWest().lng, bounds.getSouthWest().lat ],
			[ bounds.getSouthWest().lng, bounds.getNorthEast().lat ],
		];

		return tileArray;
	}

	function getPolygonByBounds(bounds) {

		var tilePolygonData = getArrayByBounds(bounds);

		var polygon = turf.polygon([tilePolygonData]);

		return polygon;
	}

	function isTileInSelection(tileRect) {

		var polygon = getPolygonByBounds(tileRect);

		var areaPolygon = draw.getAll().features[0];

		if(turf.booleanDisjoint(polygon, areaPolygon) == false) {
			return true;
		}

		return false;
	}

	function getBounds() {

		var coordinates = draw.getAll().features[0].geometry.coordinates[0];

		var bounds = coordinates.reduce(function(bounds, coord) {
			return bounds.extend(coord);
		}, new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]));

		return bounds;
	}

	function getGrid(zoomLevel) {

		var bounds = getBounds();

		var rects = [];

		var outputScale = $("#output-scale").val();
		//var thisZoom = zoomLevel - (outputScale-1)
		var thisZoom = zoomLevel

		var TY    = lat2tile(bounds.getNorthEast().lat, thisZoom);
		var LX   = long2tile(bounds.getSouthWest().lng, thisZoom);
		var BY = lat2tile(bounds.getSouthWest().lat, thisZoom);
		var RX  = long2tile(bounds.getNorthEast().lng, thisZoom);

		for(var y = TY; y <= BY; y++) {
			for(var x = LX; x <= RX; x++) {

				var rect = getTileRect(x, y, thisZoom);

				if(isTileInSelection(rect)) {
					rects.push({
						x: x,
						y: y,
						z: thisZoom,
						rect: rect,
					});
				}

			}
		}

		return rects
	}

	function countGridTiles(minZoom, maxZoom) {
		var total = 0;

		for(var z = minZoom; z <= maxZoom; z++) {
			var bounds = getBounds();
			var TY = lat2tile(bounds.getNorthEast().lat, z);
			var LX = long2tile(bounds.getSouthWest().lng, z);
			var BY = lat2tile(bounds.getSouthWest().lat, z);
			var RX = long2tile(bounds.getNorthEast().lng, z);

			for(var y = TY; y <= BY; y++) {
				for(var x = LX; x <= RX; x++) {
					if(isTileInSelection(getTileRect(x, y, z))) {
						total++;
					}
				}
			}
		}

		return total;
	}

	function createTileBatchIterator(minZoom, maxZoom, batchSize, startOffset) {
		var zoom = minZoom;
		var bounds = getBounds();
		var range = null;
		var x = 0;
		var y = 0;
		var skippedTiles = 0;
		startOffset = startOffset || 0;

		function setRangeForZoom() {
			if(zoom > maxZoom) {
				range = null;
				return;
			}

			range = {
				TY: lat2tile(bounds.getNorthEast().lat, zoom),
				LX: long2tile(bounds.getSouthWest().lng, zoom),
				BY: lat2tile(bounds.getSouthWest().lat, zoom),
				RX: long2tile(bounds.getNorthEast().lng, zoom),
			};
			x = range.LX;
			y = range.TY;
		}

		setRangeForZoom();

		return function nextBatch() {
			var batch = [];

			while(range && batch.length < batchSize) {
				var rect = getTileRect(x, y, zoom);
				if(isTileInSelection(rect)) {
					if(skippedTiles < startOffset) {
						skippedTiles++;
					} else {
						batch.push({
							x: x,
							y: y,
							z: zoom,
						});
					}
				}

				x++;
				if(x > range.RX) {
					x = range.LX;
					y++;
				}
				if(y > range.BY) {
					zoom++;
					setRangeForZoom();
				}
			}

			return batch;
		}
	}

	function removeGrid() {
		removeLayer("grid-preview");
	}

	function previewGrid() {

		var maxZoom = getMaxZoom();
		var totalTiles = countGridTiles(getMinZoom(), getMaxZoom());

		if(totalTiles > MAX_GRID_PREVIEW_TILES) {
			removeGrid();
			M.toast({html: 'Total ' + totalTiles.toLocaleString() + ' tiles in the region. Grid preview skipped for large selections.', displayLength: 7000})
			return;
		}

		var grid = getGrid(maxZoom);

		var pointsCollection = []

		for(var i in grid) {
			var feature = grid[i];
			var array = getArrayByBounds(feature.rect);
			pointsCollection.push(array);
		}

		removeGrid();

		map.addLayer({
			'id': "grid-preview",
			'type': 'line',
			'source': {
				'type': 'geojson',
				'data': turf.polygon(pointsCollection),
			},
			'layout': {},
			'paint': {
				"line-color": "#fa8231",
				"line-width": 3,
			}
		});

		M.toast({html: 'Total ' + totalTiles.toLocaleString() + ' tiles in the region.', displayLength: 5000})

	}

	function previewRect(rectInfo) {

		var array = getArrayByBounds(getTileRect(rectInfo.x, rectInfo.y, rectInfo.z));

		var id = "temp-" + rectInfo.x + '-' + rectInfo.y + '-' + rectInfo.z;

		map.addLayer({
			'id': id,
			'type': 'line',
			'source': {
				'type': 'geojson',
				'data': turf.polygon([array]),
			},
			'layout': {},
			'paint': {
				"line-color": "#ff9f1a",
				"line-width": 3,
			}
		});

		return id;
	}

	function removeLayer(id) {
		if(map.getSource(id) != null) {
			map.removeLayer(id);
			map.removeSource(id);
		}
	}

	function generateQuadKey(x, y, z) {
	    var quadKey = [];
	    for (var i = z; i > 0; i--) {
	        var digit = '0';
	        var mask = 1 << (i - 1);
	        if ((x & mask) != 0) {
	            digit++;
	        }
	        if ((y & mask) != 0) {
	            digit++;
	            digit++;
	        }
	        quadKey.push(digit);
	    }
	    return quadKey.join('');
	}

	function initializeDownloader() {

		bar = new ProgressBar.Circle($('#progress-radial').get(0), {
			strokeWidth: 12,
			easing: 'easeOut',
			duration: 200,
			trailColor: '#eee',
			trailWidth: 1,
			from: {color: '#0fb9b1', a:0},
			to: {color: '#20bf6b', a:1},
			svgStyle: null,
			step: function(state, circle) {
				circle.path.setAttribute('stroke', state.color);
			}
		});

		$("#download-button").click(startDownloading)
		$("#stop-button").click(stopDownloading)
		$("#retry-failed-button").click(retryFailedTiles)
		$("#pause-button").click(toggleDownloadPause)

		var timestamp = Date.now().toString();
		//$("#output-directory-box").val(timestamp)
	}

	function showTinyTile(base64) {
		var currentImages = $(".tile-strip img");

		for(var i = 4; i < currentImages.length; i++) {
			$(currentImages[i]).remove();
		}

		var image = $("<img/>").attr('src', "data:image/png;base64, " + base64)

		var strip = $(".tile-strip");
		strip.prepend(image)
	}

	function getAjaxErrorMessage(xhr, fallback) {
		if(xhr && xhr.responseJSON) {
			if(xhr.responseJSON.error) {
				return (xhr.responseJSON.message || fallback) + ": " + xhr.responseJSON.error;
			}
			if(xhr.responseJSON.message) {
				return xhr.responseJSON.message;
			}
		}

		if(xhr && xhr.responseText) {
			return xhr.responseText;
		}

		return fallback;
	}

	function createDownloadFormData(session) {
		var data = new FormData();
		data.append('minZoom', session.minZoom)
		data.append('maxZoom', session.maxZoom)
		data.append('outputDirectory', session.outputDirectory)
		data.append('outputFile', session.outputFile)
		data.append('outputType', session.outputType)
		data.append('outputScale', session.outputScale)
		data.append('tileScheme', session.tileScheme)
		data.append('source', session.source)
		data.append('timestamp', session.timestamp)
		data.append('bounds', session.boundsArray.join(","))
		data.append('center', session.centerArray.join(","))

		return data;
	}

	function createTileFormData(session, item) {
		var data = createDownloadFormData(session);
		data.append('x', item.x)
		data.append('y', item.y)
		data.append('z', item.z)
		data.append('quad', generateQuadKey(item.x, item.y, item.z))
		if(session.previewCounter % PREVIEW_TILE_INTERVAL == 0) {
			data.append('preview', '1')
		}
		session.previewCounter++;

		return data;
	}

	function tileKey(item) {
		return item.z + "/" + item.x + "/" + item.y;
	}

	function addFailedTile(session, item) {
		session.failedTiles[tileKey(item)] = {
			x: item.x,
			y: item.y,
			z: item.z,
		};
	}

	function removeFailedTile(session, item) {
		delete session.failedTiles[tileKey(item)];
	}

	function getFailedTileList(session) {
		var tiles = [];
		for(var key in session.failedTiles) {
			tiles.push(session.failedTiles[key]);
		}
		return tiles;
	}

	function updateRetryButton(session) {
		var count = session ? getFailedTileList(session).length : 0;
		if(count > 0 && !isDownloadActive && !downloadEnded) {
			$("#retry-failed-button").html("RETRY FAILED (" + count.toLocaleString() + ")").show();
		} else {
			$("#retry-failed-button").hide();
		}
	}

	function updatePauseButton() {
		if(isDownloadActive) {
			$("#pause-button").html(isDownloadPaused ? "CONTINUE" : "PAUSE").show().prop("disabled", false);
		} else {
			$("#pause-button").hide();
		}
	}

	function resolvePausedDownloads() {
		var callbacks = resumeCallbacks;
		resumeCallbacks = [];

		for(var i = 0; i < callbacks.length; i++) {
			callbacks[i]();
		}
	}

	function waitUntilDownloadResumed(callback) {
		if(!isDownloadPaused) {
			callback();
			return;
		}

		resumeCallbacks.push(callback);
	}

	function toggleDownloadPause() {
		if(!isDownloadActive) {
			return;
		}

		if(isDownloadPaused) {
			isDownloadPaused = false;
			updatePauseButton();
			logItemRaw("Download resumed");
			resolvePausedDownloads();
		} else {
			isDownloadPaused = true;
			updatePauseButton();
			logItemRaw("Download paused. Active requests will finish.");
		}
	}

	function isSuccessfulTileResponse(data) {
		return data && data.code == 200 && (data.message == "Tile Downloaded" || data.message == "Tile already exists");
	}

	function getTileFailureMessage(data) {
		if(data && data.message == "Download failed") {
			return data.code + " Download failed";
		}
		if(data && (data.code == 403 || data.code == 429)) {
			return data.code + " Rate limited by tile server";
		}
		if(data && data.code) {
			return data.code + " Error downloading tile";
		}

		return "Error downloading tile";
	}

	function setDownloadControlsRunning(text) {
		isDownloadActive = true;
		isDownloadPaused = false;
		resolvePausedDownloads();
		$("#stop-button").html(text || "STOP").prop("disabled", false);
		$("#retry-failed-button").hide();
		updatePauseButton();
	}

	function setDownloadControlsDone(session) {
		isDownloadActive = false;
		isDownloadPaused = false;
		resolvePausedDownloads();
		$("#stop-button").html("FINISH").prop("disabled", false);
		updatePauseButton();
		updateRetryButton(session);
	}

	function trackRequest(request) {
		var requestId = requestSequence++;
		requests[requestId] = request;
		return requestId;
	}

	function untrackRequest(requestId) {
		delete requests[requestId];
	}

	async function downloadTileBatch(session, tiles, totalTiles) {
		updateProgress(session.completedTiles, totalTiles);

		return new Promise(function(resolve) {
			async.eachLimit(tiles, session.numThreads, function(item, done) {

				if(cancellationToken) {
					done();
					return;
				}

				waitUntilDownloadResumed(function() {
					if(cancellationToken) {
						done();
						return;
					}

					var boxLayer = previewRect(item);
					var request = $.ajax({
						"url": "/download-tile",
						async: true,
						timeout: 30 * 1000,
						type: "post",
					    contentType: false,
					    processData: false,
						data: createTileFormData(session, item),
						dataType: 'json',
					}).done(function(data) {

						if(cancellationToken) {
							return;
						}

						if(isSuccessfulTileResponse(data)) {
							removeFailedTile(session, item);
							if(data.image) {
								showTinyTile(data.image)
							}
							logItem(item.x, item.y, item.z, data.message);
						} else {
							addFailedTile(session, item);
							var failureMessage = getTileFailureMessage(data);
							logItem(item.x, item.y, item.z, failureMessage);

							if(data && (data.code == 403 || data.code == 429) && !session.rateLimitWarned) {
								session.rateLimitWarned = true;
								M.toast({html: 'Tile server is rate limiting requests. Try a different source or wait a few minutes.', displayLength: 8000});
							}
						}

					}).fail(function(data) {

						if(cancellationToken) {
							return;
						}

						addFailedTile(session, item);
						logItem(item.x, item.y, item.z, getAjaxErrorMessage(data, "Error while relaying tile"));

					}).always(function() {
						session.completedTiles++;

						removeLayer(boxLayer);
						updateProgress(session.completedTiles, totalTiles);
						untrackRequest(requestId);

						done();
					});

					var requestId = trackRequest(request);
				});

			}, function() {
				resolve();
			});
		});
	}

	async function downloadTilesStream(session) {
		if((session.startTileOffset || 0) >= session.totalTiles) {
			return;
		}

		var nextBatch = createTileBatchIterator(session.minZoom, session.maxZoom, TILE_BATCH_SIZE, session.startTileOffset || 0);

		while(!cancellationToken) {
			var tiles = nextBatch();
			if(tiles.length == 0) {
				break;
			}

			await downloadTileBatch(session, tiles, session.totalTiles);
			tiles.length = 0;
		}
	}

	async function scanContinueDirectory(session) {
		$("#download-phase-title").text("Checking downloaded tiles");
		$("#download-phase-hint").text("Scanning selected directory in the background...");
		logItemRaw("Checking existing directory in download order...");

		var request = $.ajax({
			url: "/scan-continue-directory",
			async: true,
			timeout: 10 * 60 * 1000,
			type: "post",
			contentType: false,
			processData: false,
			data: createDownloadFormData(session),
			dataType: 'json',
		});
		var requestId = trackRequest(request);
		var result = await request.always(function() {
			untrackRequest(requestId);
		});

		session.startTileOffset = result.startTileOffset || 0;
		session.sparseMissingTiles = result.sparseMissingTiles || [];
		session.completedTiles = result.completedTiles || 0;
		updateProgress(session.completedTiles, session.totalTiles);
		var lastExistingOffset = result.lastExistingOffset !== undefined ? result.lastExistingOffset : -1;
		logItemRaw("Last existing tile offset: " + lastExistingOffset.toLocaleString());
		logItemRaw("Resume start offset: " + session.startTileOffset.toLocaleString());
		logItemRaw("Sparse missing tile(s): " + session.sparseMissingTiles.length.toLocaleString());
	}

	async function finalizeDownload(session) {
		$("#retry-failed-button").hide();
		$("#pause-button").hide();
		$("#stop-button").html("FINISHING...").prop("disabled", true);

		await $.ajax({
			url: "/end-download",
			async: true,
			timeout: 30 * 1000,
			type: "post",
			contentType: false,
			processData: false,
			data: createDownloadFormData(session),
			dataType: 'json',
		})
		downloadEnded = true;

		if ($("#stitch-checkbox").is(":checked")) {
			$("#stop-button").html("STITCHING...").prop("disabled", true);
			$("#download-phase-title").text("Stitching tiles");
			$("#download-phase-hint").text("Building image from tiles, please wait...");

			var stitchData = new FormData();
			stitchData.append('outputDirectory', session.outputDirectory);
			stitchData.append('timestamp', session.timestamp);
			stitchData.append('minZoom', session.minZoom);
			stitchData.append('maxZoom', session.maxZoom);

			await $.ajax({
				url: "/stitch-tiles",
				async: true,
				timeout: 30 * 1000,
				type: "post",
				contentType: false,
				processData: false,
				data: stitchData,
				dataType: 'json',
			});

			await pollStitchStatus();

			$("#download-phase-title").text("Downloading tiles");
			$("#download-phase-hint").text("Please wait...");
		}

		$("#stop-button").html("FINISH").prop("disabled", false);
	}

	function finishDownloadView() {
		$("#main-sidebar").show();
		$("#download-sidebar").hide();
		$("#retry-failed-button").hide();
		$("#pause-button").hide();
		removeGrid();
		clearLogs();
	}

	async function finishDownload() {
		if(!currentDownload || !currentDownload.started) {
			finishDownloadView();
			return;
		}

		try {
			if(!downloadEnded) {
				await finalizeDownload(currentDownload);
			}
			finishDownloadView();
		} catch(xhr) {
			var message = getAjaxErrorMessage(xhr, "Could not finish download.");
			logItemRaw(message);
			M.toast({html: message, displayLength: 8000});
			setDownloadControlsDone(currentDownload);
		}
	}

	async function retryFailedTiles() {
		if(!currentDownload || isDownloadActive || downloadEnded) {
			return;
		}

		var failedTiles = getFailedTileList(currentDownload);
		if(failedTiles.length == 0) {
			updateRetryButton(currentDownload);
			return;
		}

		cancellationToken = false;
		requests = [];
		setDownloadControlsRunning("STOP");
		logItemRaw("Retrying " + failedTiles.length.toLocaleString() + " failed tile(s)");

		currentDownload.completedTiles = 0;
		await downloadTileBatch(currentDownload, failedTiles, failedTiles.length);

		if(cancellationToken) {
			return;
		}

		var remaining = getFailedTileList(currentDownload).length;
		logItemRaw(remaining.toLocaleString() + " failed tile(s) remaining");

		if(remaining == 0) {
			logItemRaw("All requests are done");
			try {
				await finalizeDownload(currentDownload);
			} catch(xhr) {
				var message = getAjaxErrorMessage(xhr, "Could not finish download.");
				logItemRaw(message);
				M.toast({html: message, displayLength: 8000});
			}
		}

		setDownloadControlsDone(currentDownload);
	}

	async function startDownloading() {

		if(draw.getAll().features.length == 0) {
			M.toast({html: 'You need to select a region first.', displayLength: 3000})
			return;
		}

		var continueDirectory = null;
		if($("#continue-download-checkbox").is(":checked")) {
			var continueDirectoryPath = ($("#continue-download-path").val() || "").trim();
			if(!continueDirectoryPath) {
				M.toast({html: 'Enter a downloaded directory path to continue.', displayLength: 5000});
				return;
			}

			if(!continueDirectoryState || continueDirectoryState.directoryPath != continueDirectoryPath) {
				try {
					await loadContinueDirectoryPath(continueDirectoryPath);
				} catch(error) {
					return;
				}
			}
			continueDirectory = continueDirectoryPath;
		}

		cancellationToken = false;
		requests = [];
		downloadEnded = false;

		$("#main-sidebar").hide();
		$("#download-sidebar").show();
		$(".tile-strip").html("");
		$("#retry-failed-button").hide();
		$("#pause-button").hide();
		setDownloadControlsRunning("STOP");
		removeGrid();
		clearLogs();
		M.Toast.dismissAll();

		var timestamp = Date.now().toString();
		var bounds = getBounds();
		var minZoom = getMinZoom();
		var maxZoom = getMaxZoom();
		var totalTiles = countGridTiles(minZoom, maxZoom);
		var outputDirectory = continueDirectory || $("#output-directory-box").val();
		var outputFile = $("#output-file-box").val();
		var outputType = continueDirectory ? "directory" : $("#output-type").val();

		if(continueDirectory) {
			logItemRaw("Continuing existing directory: " + continueDirectory);
		}

		currentDownload = {
			timestamp: timestamp,
			numThreads: parseInt($("#parallel-threads-box").val()),
			outputDirectory: outputDirectory,
			outputFile: outputFile,
			outputType: outputType,
			outputScale: $("#output-scale").val(),
			tileScheme: getTileScheme(),
			source: $("#source-box").val(),
			minZoom: minZoom,
			maxZoom: maxZoom,
			totalTiles: totalTiles,
			completedTiles: 0,
			startTileOffset: 0,
			sparseMissingTiles: [],
			continueDirectory: continueDirectoryState,
			previewCounter: 0,
			boundsArray: [bounds.getSouthWest().lng, bounds.getSouthWest().lat, bounds.getNorthEast().lng, bounds.getNorthEast().lat],
			centerArray: [bounds.getCenter().lng, bounds.getCenter().lat, maxZoom],
			failedTiles: {},
			rateLimitWarned: false,
			started: false
		};

		try {
			await $.ajax({
				url: "/start-download",
				async: true,
				timeout: 30 * 1000,
				type: "post",
				contentType: false,
				processData: false,
				data: createDownloadFormData(currentDownload),
				dataType: 'json',
			})
			currentDownload.started = true;
		} catch(xhr) {
			var message = getAjaxErrorMessage(xhr, "Could not start download.");
			logItemRaw(message);
			M.toast({html: message, displayLength: 8000});
			setDownloadControlsDone(currentDownload);
			return;
		}

		if(continueDirectory) {
			try {
				await scanContinueDirectory(currentDownload);
			} catch(xhr) {
				if(!cancellationToken) {
					var message = getAjaxErrorMessage(xhr, "Could not check existing directory.");
					logItemRaw(message);
					M.toast({html: message, displayLength: 8000});
					setDownloadControlsDone(currentDownload);
				}
				return;
			}

			if(cancellationToken) {
				return;
			}

			$("#download-phase-title").text("Downloading tiles");
			$("#download-phase-hint").text("Please wait...");

			if(currentDownload.sparseMissingTiles.length > 0) {
				logItemRaw("Downloading sparse missing tile(s): " + currentDownload.sparseMissingTiles.length.toLocaleString());
				await downloadTileBatch(currentDownload, currentDownload.sparseMissingTiles, currentDownload.totalTiles);

				if(cancellationToken) {
					return;
				}
				currentDownload.sparseMissingTiles.length = 0;
				currentDownload.completedTiles = currentDownload.startTileOffset;
				updateProgress(currentDownload.completedTiles, currentDownload.totalTiles);
			}
		}

		await downloadTilesStream(currentDownload);

		if(cancellationToken) {
			return;
		}

		var failedCount = getFailedTileList(currentDownload).length;
		logItemRaw("All requests are done");

		if(failedCount == 0) {
			try {
				await finalizeDownload(currentDownload);
			} catch(xhr) {
				var message = getAjaxErrorMessage(xhr, "Could not finish download.");
				logItemRaw(message);
				M.toast({html: message, displayLength: 8000});
			}
		} else {
			logItemRaw(failedCount.toLocaleString() + " failed tile(s) remaining");
		}

		setDownloadControlsDone(currentDownload);

	}

	function updateProgress(value, total) {
		if(total == 0) {
			bar.animate(1);
			bar.setText('100<span>%</span>');
			$("#progress-subtitle").html("0 <span>out of</span> 0")
			return;
		}

		var progress = value / total;

		bar.animate(progress);
		bar.setText(Math.round(progress * 100) + '<span>%</span>');

		$("#progress-subtitle").html(value.toLocaleString() + " <span>out of</span> " + total.toLocaleString())
	}

	function logItem(x, y, z, text) {
		logItemRaw(x + ',' + y + ',' + z + ' : ' + text)
	}

	function logItemRaw(text) {

		var logger = $('#log-view');
		var lines = logger.val() ? logger.val().split('\n') : [];
		lines.push(text);
		if(lines.length > MAX_LOG_LINES) {
			lines = lines.slice(lines.length - MAX_LOG_LINES);
		}
		logger.val(lines.join('\n'));

		logger.scrollTop(logger[0].scrollHeight);
	}

	function clearLogs() {
		var logger = $('#log-view');
		logger.val('');
	}

	function stopDownloading() {
		if(!isDownloadActive) {
			finishDownload();
			return;
		}

		cancellationToken = true;
		isDownloadActive = false;
		isDownloadPaused = false;
		resolvePausedDownloads();

		for(var requestId in requests) {
			var request = requests[requestId];
			try {
				request.abort();
			} catch(e) {

			}
		}
		requests = [];

		$("#main-sidebar").show();
		$("#download-sidebar").hide();
		$("#retry-failed-button").hide();
		$("#pause-button").hide();
		removeGrid();
		clearLogs();

	}

	initializeMaterialize();
	initializeSources();
	initializeMap();
	initializeSearch();
	initializeRectangleTool();
	initializeGridPreview();
	initializeMoreOptions();
	initializeDownloader();
});
