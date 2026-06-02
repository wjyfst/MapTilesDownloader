var mapView;

$(function() {

	var map = null;
	var draw = null;
	var geocoder = null;
	var bar = null;

	var cancellationToken = null;
	var requests = [];
	var currentDownload = null;
	var isDownloadActive = false;
	var downloadEnded = false;
	var isDownloadPaused = false;
	var resumeCallbacks = [];

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

	function getMapPreviewSource(url) {
		if(!url || url.indexOf("{quad}") >= 0) {
			return null;
		}

		var previewUrl = url;
		var scheme = "xyz";

		if(previewUrl.indexOf("{tmsY}") >= 0) {
			previewUrl = previewUrl.split("{tmsY}").join("{y}");
			scheme = "tms";
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

		updateStitchCheckboxState();

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

	}

	function startDrawing() {
		removeGrid();
		draw.deleteAll();
		draw.changeMode('draw_rectangle');

		M.Toast.dismissAll();
		M.toast({html: 'Click two points on the map to make a rectangle.', displayLength: 7000})
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

	function getAllGridTiles() {
		var allTiles = [];

		for(var z = getMinZoom(); z <= getMaxZoom(); z++) {
			var grid = getGrid(z);
			// TODO shuffle grid via a heuristic (hamlet curve? :/)
			allTiles = allTiles.concat(grid);
		}

		return allTiles;
	}

	function removeGrid() {
		removeLayer("grid-preview");
	}

	function previewGrid() {

		var maxZoom = getMaxZoom();
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

		var totalTiles = getAllGridTiles().length;
		M.toast({html: 'Total ' + totalTiles.toLocaleString() + ' tiles in the region.', displayLength: 5000})

	}

	function previewRect(rectInfo) {

		var array = getArrayByBounds(rectInfo.rect);

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

		return data;
	}

	function tileKey(item) {
		return item.z + "/" + item.x + "/" + item.y;
	}

	function addFailedTile(session, item) {
		session.failedTiles[tileKey(item)] = item;
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

	async function downloadTileBatch(session, tiles) {
		var completed = 0;
		updateProgress(0, tiles.length);

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
						completed++;

						removeLayer(boxLayer);
						updateProgress(completed, tiles.length);

						done();
					});

					requests.push(request);
				});

			}, function() {
				resolve();
			});
		});
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

		await downloadTileBatch(currentDownload, failedTiles);

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
		var allTiles = getAllGridTiles();
		var bounds = getBounds();

		currentDownload = {
			timestamp: timestamp,
			allTiles: allTiles,
			numThreads: parseInt($("#parallel-threads-box").val()),
			outputDirectory: $("#output-directory-box").val(),
			outputFile: $("#output-file-box").val(),
			outputType: $("#output-type").val(),
			outputScale: $("#output-scale").val(),
			source: $("#source-box").val(),
			minZoom: getMinZoom(),
			maxZoom: getMaxZoom(),
			boundsArray: [bounds.getSouthWest().lng, bounds.getSouthWest().lat, bounds.getNorthEast().lng, bounds.getNorthEast().lat],
			centerArray: [bounds.getCenter().lng, bounds.getCenter().lat, getMaxZoom()],
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

		await downloadTileBatch(currentDownload, allTiles);

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
		logger.val(logger.val() + '\n' + text);

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

		for(var i =0 ; i < requests.length; i++) {
			var request = requests[i];
			try {
				request.abort();
			} catch(e) {

			}
		}

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
