#!/usr/bin/env python

from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
import threading

from urllib.parse import urlparse
from urllib.parse import parse_qs
from urllib.parse import parse_qsl
import urllib.request
import email
from email.message import Message
import uuid
import random
import string
import argparse
import uuid
import random
import json
import shutil
import ssl
import glob
import os
import base64
import mimetypes
import traceback
import math

from file_writer import FileWriter
from mbtiles_writer import MbtilesWriter
from repo_writer import RepoWriter
from utils import Utils

try:
    from stitch import Stitcher
    STITCH_AVAILABLE = True
except ImportError:
    STITCH_AVAILABLE = False

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

lock = threading.Lock()

stitch_job = {"state": "idle", "message": "", "files": []}
stitch_job_lock = threading.Lock()


def run_stitch(output_dir, min_zoom, max_zoom):
    try:
        files = []
        for zoom in range(min_zoom, max_zoom + 1):
            with stitch_job_lock:
                stitch_job["state"] = "stitching"
                stitch_job["message"] = f"Stitching zoom level {zoom}..."

            path = Stitcher.stitch_zoom_level(output_dir, zoom)
            if path:
                files.append(path)

        with stitch_job_lock:
            stitch_job["state"] = "done"
            stitch_job["message"] = f"Stitched {len(files)} zoom level(s)"
            stitch_job["files"] = files

    except Exception as e:
        with stitch_job_lock:
            stitch_job["state"] = "error"
            stitch_job["message"] = str(e)


def _parse_header(line):
    msg = Message()
    msg['content-type'] = line
    params = msg.get_params()
    if not params:
        return line, {}
    main = params[0][0]
    pdict = {k: v for k, v in params[1:]}
    return main, pdict


def _parse_multipart(fp, pdict):
    boundary = pdict['boundary']
    if isinstance(boundary, bytes):
        boundary = boundary.decode('utf-8')
    length = pdict.get('CONTENT-LENGTH', -1)
    body = fp.read(length) if isinstance(length, int) and length >= 0 else fp.read()
    msg = email.message_from_bytes(
        f'Content-Type: multipart/form-data; boundary={boundary}\r\n\r\n'.encode() + body
    )
    result = {}
    for part in msg.walk():
        if part.get_content_maintype() == 'multipart':
            continue
        name = part.get_param('name', header='content-disposition')
        if name:
            payload = part.get_payload(decode=True)
            if payload is not None:
                try:
                    value = payload.decode('utf-8')
                except UnicodeDecodeError:
                    value = payload.decode('latin-1')
                result.setdefault(name, []).append(value)
    return result


class serverHandler(BaseHTTPRequestHandler):

	def randomString(self):
		return uuid.uuid4().hex.upper()[0:6]

	def writerByType(self, type):
		if(type == "mbtiles"):
			return MbtilesWriter
		elif(type == "repo"):
			return RepoWriter
		elif(type == "directory"):
			return FileWriter
		raise ValueError("Invalid outputType: " + str(type))

	def sendJson(self, result, status=200):
		self.send_response(status)
		self.send_header("Content-Type", "application/json")
		self.end_headers()
		self.wfile.write(json.dumps(result).encode('utf-8'))

	def formValue(self, postvars, key):
		if key not in postvars or len(postvars[key]) == 0:
			raise ValueError("Missing form field: " + key)
		return postvars[key][0]

	def optionalFormValue(self, postvars, key, default):
		if key not in postvars or len(postvars[key]) == 0:
			return default
		return postvars[key][0]

	def tileScheme(self, postvars):
		scheme = str(self.optionalFormValue(postvars, 'tileScheme', 'xyz')).lower()
		if scheme not in ["xyz", "tms"]:
			raise ValueError("Invalid tileScheme: " + scheme)
		return scheme

	def replaceTilePlaceholders(self, value, x, y, z, quad, timestamp, tileScheme):
		tmsY = (2 ** z) - y - 1
		schemeY = tmsY if tileScheme == "tms" else y
		replaceMap = {
			"x": str(x),
			"y": str(schemeY),
			"xyzY": str(y),
			"tmsY": str(tmsY),
			"z": str(z),
			"quad": quad,
			"timestamp": str(timestamp),
		}

		for key, replacement in replaceMap.items():
			value = value.replace("{" + key + "}", replacement)
		return value

	def outputPath(self, outputDirectory, *parts):
		if os.path.isabs(outputDirectory):
			return os.path.join(outputDirectory, *parts)
		return os.path.join(BASE_DIR, "output", outputDirectory, *parts)

	def writeDownloadSession(self, outputDirectory, session):
		session_dir = self.outputPath(outputDirectory)
		os.makedirs(session_dir, exist_ok=True)
		session_path = os.path.join(session_dir, "download-session.json")
		with open(session_path, "w", encoding="utf-8") as session_file:
			json.dump(session, session_file, indent=2)

	def parseNumberList(self, value):
		if isinstance(value, list):
			return [float(item) for item in value]
		if value is None or value == "":
			return None
		return [float(item) for item in str(value).split(",")]

	def firstMetadataValue(self, metadata, keys, defaultValue=None):
		for key in keys:
			if key in metadata and metadata[key] not in [None, ""]:
				return metadata[key]
		return defaultValue

	def sessionFromMetadata(self, outputDirectory, metadata):
		tileSize = int(self.firstMetadataValue(metadata, ["tilesize", "tileSize"], 256))
		outputScale = max(1, int(tileSize / 256))

		minZoomValue = self.firstMetadataValue(metadata, ["minzoom", "minZoom"])
		maxZoomValue = self.firstMetadataValue(metadata, ["maxzoom", "maxZoom"])
		minZoom = int(minZoomValue) if minZoomValue not in [None, ""] else None
		maxZoom = int(maxZoomValue) if maxZoomValue not in [None, ""] else None

		return {
			"outputDirectory": outputDirectory,
			"outputFile": "{z}/{x}/{y}.png",
			"outputType": "directory",
			"outputScale": outputScale,
			"tileScheme": self.firstMetadataValue(metadata, ["scheme", "tileScheme"], "xyz"),
			"minZoom": minZoom,
			"maxZoom": maxZoom,
			"bounds": self.parseNumberList(self.firstMetadataValue(metadata, ["bounds"])),
			"center": self.parseNumberList(self.firstMetadataValue(metadata, ["center"])),
		}

	def continueDirectoryConfig(self, postvars):
		outputDirectory = str(self.formValue(postvars, 'outputDirectory')).strip()
		directoryPath = self.outputPath(outputDirectory)
		if not os.path.isdir(directoryPath):
			raise ValueError("Downloaded directory does not exist: " + directoryPath)

		result = {
			"code": 200,
			"outputDirectory": outputDirectory,
			"configSource": None,
			"session": None,
		}

		sessionPath = os.path.join(directoryPath, "download-session.json")
		if os.path.isfile(sessionPath):
			with open(sessionPath, "r", encoding="utf-8") as sessionFile:
				result["session"] = json.load(sessionFile)
			result["configSource"] = "download-session.json"
			return result

		metadataPath = os.path.join(directoryPath, "metadata.json")
		if os.path.isfile(metadataPath):
			with open(metadataPath, "r", encoding="utf-8") as metadataFile:
				metadata = json.load(metadataFile)
			result["session"] = self.sessionFromMetadata(outputDirectory, metadata)
			result["configSource"] = "metadata.json"

		return result

	def chooseDirectory(self):
		try:
			import tkinter as tk
			from tkinter import filedialog

			root = tk.Tk()
			root.withdraw()
			root.attributes("-topmost", True)
			path = filedialog.askdirectory(title="Select downloaded tile folder")
			root.destroy()
			return {
				"code": 200,
				"path": path or "",
			}
		except Exception as e:
			return {
				"code": 500,
				"message": "Could not open folder picker",
				"error": str(e),
			}

	def long2tile(self, lon, zoom):
		return math.floor((lon + 180) / 360 * math.pow(2, zoom))

	def lat2tile(self, lat, zoom):
		return math.floor((1 - math.log(math.tan(lat * math.pi / 180) + 1 / math.cos(lat * math.pi / 180)) / math.pi) / 2 * math.pow(2, zoom))

	def tile2long(self, x, zoom):
		return x / math.pow(2, zoom) * 360 - 180

	def tile2lat(self, y, zoom):
		n = math.pi - 2 * math.pi * y / math.pow(2, zoom)
		return 180 / math.pi * math.atan(0.5 * (math.exp(n) - math.exp(-n)))

	def tileIntersectsBounds(self, x, y, z, bounds):
		west, south, east, north = bounds
		tile_west = self.tile2long(x, z)
		tile_east = self.tile2long(x + 1, z)
		tile_north = self.tile2lat(y, z)
		tile_south = self.tile2lat(y + 1, z)

		return not (
			tile_east < west or
			tile_west > east or
			tile_north < south or
			tile_south > north
		)

	def iterTilesInBounds(self, bounds, minZoom, maxZoom):
		west, south, east, north = bounds
		for z in range(minZoom, maxZoom + 1):
			ty = self.lat2tile(north, z)
			lx = self.long2tile(west, z)
			by = self.lat2tile(south, z)
			rx = self.long2tile(east, z)

			for y in range(ty, by + 1):
				for x in range(lx, rx + 1):
					if self.tileIntersectsBounds(x, y, z, bounds):
						yield {"x": x, "y": y, "z": z}

	def scanContinueDirectory(self, postvars):
		outputDirectory = str(self.formValue(postvars, 'outputDirectory'))
		outputFile = str(self.formValue(postvars, 'outputFile'))
		outputType = str(self.formValue(postvars, 'outputType'))
		timestamp = int(self.formValue(postvars, 'timestamp'))
		tileScheme = self.tileScheme(postvars)
		minZoom = int(self.formValue(postvars, 'minZoom'))
		maxZoom = int(self.formValue(postvars, 'maxZoom'))
		bounds = list(map(float, str(self.formValue(postvars, 'bounds')).split(",")))

		if outputType != "directory":
			raise ValueError("Continue scan only supports directory output")

		writer = self.writerByType(outputType)
		missingTiles = []
		lastExistingOffset = -1
		checkedCount = 0

		for offset, tile in enumerate(self.iterTilesInBounds(bounds, minZoom, maxZoom)):
			x = int(tile["x"])
			y = int(tile["y"])
			z = int(tile["z"])
			quad = Utils.makeQuadKey(x, y, z)
			resolvedDirectory = self.replaceTilePlaceholders(outputDirectory, x, y, z, quad, timestamp, tileScheme)
			resolvedFile = self.replaceTilePlaceholders(outputFile, x, y, z, quad, timestamp, tileScheme)
			filePath = self.outputPath(resolvedDirectory, resolvedFile)

			checkedCount += 1
			if writer.exists(filePath, x, y, z, tileScheme):
				lastExistingOffset = offset
			else:
				missingTiles.append({
					"offset": offset,
					"tile": tile,
				})

		startTileOffset = lastExistingOffset + 1
		sparseMissingTiles = [
			item["tile"] for item in missingTiles
			if item["offset"] < startTileOffset
		]

		return {
			"code": 200,
			"checkedCount": checkedCount,
			"lastExistingOffset": lastExistingOffset,
			"startTileOffset": startTileOffset,
			"sparseMissingTiles": sparseMissingTiles,
			"completedTiles": startTileOffset - len(sparseMissingTiles),
		}

	def do_POST(self):
		try:
			return self._do_POST()
		except Exception as e:
			traceback.print_exc()
			self.sendJson({
				"code": 500,
				"message": "Server error while handling " + self.path,
				"error": str(e),
			}, 500)

	def _do_POST(self):

		ctype, pdict = _parse_header(self.headers.get('Content-Type'))
		if ctype != "multipart/form-data" or "boundary" not in pdict:
			raise ValueError("Expected multipart/form-data POST body")
		pdict['boundary'] = bytes(pdict['boundary'], "utf-8")

		content_len = int(self.headers.get('Content-length', 0))
		pdict['CONTENT-LENGTH'] = content_len

		postvars = _parse_multipart(self.rfile, pdict)

		parts = urlparse(self.path)
		if parts.path == '/download-tile':

			x = int(postvars['x'][0])
			y = int(postvars['y'][0])
			z = int(postvars['z'][0])
			quad = str(postvars['quad'][0])
			timestamp = int(postvars['timestamp'][0])
			outputDirectory = str(postvars['outputDirectory'][0])
			outputFile = str(postvars['outputFile'][0])
			outputType = str(postvars['outputType'][0])
			outputScale = int(postvars['outputScale'][0])
			tileScheme = self.tileScheme(postvars)
			source = str(postvars['source'][0])
			includePreview = self.optionalFormValue(postvars, 'preview', '0') == '1'
			outputDirectory = self.replaceTilePlaceholders(outputDirectory, x, y, z, quad, timestamp, tileScheme)
			outputFile = self.replaceTilePlaceholders(outputFile, x, y, z, quad, timestamp, tileScheme)

			result = {}

			filePath = self.outputPath(outputDirectory, outputFile)

			print("\n")

			if self.writerByType(outputType).exists(filePath, x, y, z, tileScheme):
				result["code"] = 200
				result["message"] = 'Tile already exists'

				print("EXISTS: " + filePath)

			else:

				tempFile = self.randomString() + ".png"
				tempFilePath = os.path.join(BASE_DIR, "temp", tempFile)

				result["code"] = Utils.downloadFileScaled(source, tempFilePath, x, y, z, outputScale)

				print("HIT: " + source + "\n" + "RETURN: " + str(result["code"]))

				if os.path.isfile(tempFilePath):
					self.writerByType(outputType).addTile(lock, filePath, tempFilePath, x, y, z, outputScale, tileScheme)

					if includePreview:
						with open(tempFilePath, "rb") as image_file:
							result["image"] = base64.b64encode(image_file.read()).decode("utf-8")

					os.remove(tempFilePath)

					result["message"] = 'Tile Downloaded'
					print("SAVE: " + filePath)

				else:
					result["message"] = 'Download failed'


			self.send_response(200)
			# self.send_header("Access-Control-Allow-Origin", "*")
			self.send_header("Content-Type", "application/json")
			self.end_headers()
			self.wfile.write(json.dumps(result).encode('utf-8'))
			return

		elif parts.path == '/continue-directory-config':
			self.sendJson(self.continueDirectoryConfig(postvars))
			return

		elif parts.path == '/scan-continue-directory':
			self.sendJson(self.scanContinueDirectory(postvars))
			return

		elif parts.path == '/start-download':
			outputType = str(self.formValue(postvars, 'outputType'))
			outputScale = int(self.formValue(postvars, 'outputScale'))
			outputDirectory = str(self.formValue(postvars, 'outputDirectory'))
			outputFile = str(self.formValue(postvars, 'outputFile'))
			minZoom = int(self.formValue(postvars, 'minZoom'))
			maxZoom = int(self.formValue(postvars, 'maxZoom'))
			timestamp = int(self.formValue(postvars, 'timestamp'))
			tileScheme = self.tileScheme(postvars)
			bounds = str(self.formValue(postvars, 'bounds'))
			boundsArray = list(map(float, bounds.split(",")))
			center = str(self.formValue(postvars, 'center'))
			centerArray = list(map(float, center.split(",")))

			writer = self.writerByType(outputType)

			replaceMap = {
				"timestamp": str(timestamp),
			}

			for key, value in replaceMap.items():
				newKey = str("{" + str(key) + "}")
				outputDirectory = outputDirectory.replace(newKey, value)
				outputFile = outputFile.replace(newKey, value)

			filePath = self.outputPath(outputDirectory, outputFile)

			writer.addMetadata(lock, self.outputPath(outputDirectory), filePath, outputFile, "Map Tiles Downloader via AliFlux", "png", boundsArray, centerArray, minZoom, maxZoom, "mercator", 256 * outputScale, tileScheme)
			self.writeDownloadSession(outputDirectory, {
				"timestamp": timestamp,
				"outputDirectory": outputDirectory,
				"outputFile": outputFile,
				"outputType": outputType,
				"outputScale": outputScale,
				"tileScheme": tileScheme,
				"source": str(self.optionalFormValue(postvars, 'source', '')),
				"minZoom": minZoom,
				"maxZoom": maxZoom,
				"bounds": boundsArray,
				"center": centerArray,
			})

			result = {}
			result["code"] = 200
			result["message"] = 'Metadata written'

			self.send_response(200)
			# self.send_header("Access-Control-Allow-Origin", "*")
			self.send_header("Content-Type", "application/json")
			self.end_headers()
			self.wfile.write(json.dumps(result).encode('utf-8'))
			return

		elif parts.path == '/end-download':
			outputType = str(postvars['outputType'][0])
			outputScale = int(postvars['outputScale'][0])
			outputDirectory = str(postvars['outputDirectory'][0])
			outputFile = str(postvars['outputFile'][0])
			minZoom = int(postvars['minZoom'][0])
			maxZoom = int(postvars['maxZoom'][0])
			timestamp = int(postvars['timestamp'][0])
			tileScheme = self.tileScheme(postvars)
			bounds = str(postvars['bounds'][0])
			boundsArray = map(float, bounds.split(","))
			center = str(postvars['center'][0])
			centerArray = map(float, center.split(","))

			replaceMap = {
				"timestamp": str(timestamp),
			}

			for key, value in replaceMap.items():
				newKey = str("{" + str(key) + "}")
				outputDirectory = outputDirectory.replace(newKey, value)
				outputFile = outputFile.replace(newKey, value)

			filePath = self.outputPath(outputDirectory, outputFile)

			self.writerByType(outputType).close(lock, self.outputPath(outputDirectory), filePath, minZoom, maxZoom, tileScheme)

			result = {}
			result["code"] = 200
			result["message"] = 'Downloaded ended'

			self.send_response(200)
			# self.send_header("Access-Control-Allow-Origin", "*")
			self.send_header("Content-Type", "application/json")
			self.end_headers()
			self.wfile.write(json.dumps(result).encode('utf-8'))
			return

		elif parts.path == '/stitch-tiles':
			if not STITCH_AVAILABLE:
				result = {"code": 500, "message": "pyvips not installed. Run: pip install pyvips[binary]"}
				self.send_response(200)
				self.send_header("Content-Type", "application/json")
				self.end_headers()
				self.wfile.write(json.dumps(result).encode('utf-8'))
				return

			outputDirectory = str(postvars['outputDirectory'][0])
			timestamp = int(postvars['timestamp'][0])
			minZoom = int(postvars['minZoom'][0])
			maxZoom = int(postvars['maxZoom'][0])

			outputDirectory = outputDirectory.replace('{timestamp}', str(timestamp))
			full_output_dir = self.outputPath(outputDirectory)

			with stitch_job_lock:
				stitch_job["state"] = "starting"
				stitch_job["message"] = "Starting..."
				stitch_job["files"] = []

			t = threading.Thread(target=run_stitch, args=(full_output_dir, minZoom, maxZoom), daemon=True)
			t.start()

			result = {"code": 200, "message": "Stitching started"}
			self.send_response(200)
			self.send_header("Content-Type", "application/json")
			self.end_headers()
			self.wfile.write(json.dumps(result).encode('utf-8'))
			return

	def do_GET(self):

		parts = urlparse(self.path)

		if parts.path == '/choose-continue-directory':
			result = self.chooseDirectory()
			self.sendJson(result, 500 if result.get("code") != 200 else 200)
			return

		if parts.path == '/stitch-status':
			with stitch_job_lock:
				result = dict(stitch_job)
			result["code"] = 200
			self.send_response(200)
			self.send_header("Content-Type", "application/json")
			self.end_headers()
			self.wfile.write(json.dumps(result).encode('utf-8'))
			return

		path = parts.path.strip('/')
		if path == "":
			path = "index.htm"

		file = os.path.join(BASE_DIR, "UI", path)

		if not os.path.isfile(file):
			self.send_response(404)
			self.end_headers()
			return

		mime = mimetypes.MimeTypes().guess_type(file)[0]

		self.send_response(200)
		# self.send_header("Access-Control-Allow-Origin", "*")
		self.send_header("Content-Type", mime)
		self.end_headers()

		with open(file, "rb") as f:
			self.wfile.write(f.read())

class serverThreadedHandler(ThreadingMixIn, HTTPServer):
	"""Handle requests in a separate thread."""

def parse_args():
	parser = argparse.ArgumentParser(description="Run the Map Tiles Downloader web UI.")
	parser.add_argument(
		"--host",
		default=os.environ.get("MTD_HOST", "127.0.0.1"),
		help="Host interface to bind to. Use 0.0.0.0 for Docker or LAN access.",
	)
	parser.add_argument(
		"--port",
		default=int(os.environ.get("MTD_PORT", "8085")),
		type=int,
		help="TCP port to listen on.",
	)
	return parser.parse_args()

def run():
	args = parse_args()
	print('Starting Server...')
	os.makedirs(os.path.join(BASE_DIR, "temp"), exist_ok=True)
	os.makedirs(os.path.join(BASE_DIR, "output"), exist_ok=True)
	server_address = (args.host, args.port)
	try:
		httpd = serverThreadedHandler(server_address, serverHandler)
	except OSError as e:
		print(f"Could not bind to {args.host}:{args.port}: {e}")
		print(f"Try another port, for example: python server.py --port {args.port + 1}")
		raise SystemExit(1) from e

	print('Running Server...')

	# os.startfile('UI\\index.htm', 'open')
	print(f"Open http://localhost:{args.port}/ to view the application.")

	httpd.serve_forever()

if __name__ == "__main__":
	run()
