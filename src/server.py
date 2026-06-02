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
import time
import json
import shutil
import ssl
import glob
import os
import base64
import mimetypes
import traceback

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
			source = str(postvars['source'][0])

			replaceMap = {
				"x": str(x),
				"y": str(y),
				"z": str(z),
				"quad": quad,
				"timestamp": str(timestamp),
			}

			for key, value in replaceMap.items():
				newKey = str("{" + str(key) + "}")
				outputDirectory = outputDirectory.replace(newKey, value)
				outputFile = outputFile.replace(newKey, value)

			result = {}

			filePath = os.path.join(BASE_DIR, "output", outputDirectory, outputFile)

			print("\n")

			if self.writerByType(outputType).exists(filePath, x, y, z):
				result["code"] = 200
				result["message"] = 'Tile already exists'

				print("EXISTS: " + filePath)

			else:

				tempFile = self.randomString() + ".png"
				tempFilePath = os.path.join(BASE_DIR, "temp", tempFile)

				result["code"] = Utils.downloadFileScaled(source, tempFilePath, x, y, z, outputScale)

				print("HIT: " + source + "\n" + "RETURN: " + str(result["code"]))

				if os.path.isfile(tempFilePath):
					self.writerByType(outputType).addTile(lock, filePath, tempFilePath, x, y, z, outputScale)

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

		elif parts.path == '/start-download':
			outputType = str(self.formValue(postvars, 'outputType'))
			outputScale = int(self.formValue(postvars, 'outputScale'))
			outputDirectory = str(self.formValue(postvars, 'outputDirectory'))
			outputFile = str(self.formValue(postvars, 'outputFile'))
			minZoom = int(self.formValue(postvars, 'minZoom'))
			maxZoom = int(self.formValue(postvars, 'maxZoom'))
			timestamp = int(self.formValue(postvars, 'timestamp'))
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

			filePath = os.path.join(BASE_DIR, "output", outputDirectory, outputFile)

			writer.addMetadata(lock, os.path.join(BASE_DIR, "output", outputDirectory), filePath, outputFile, "Map Tiles Downloader via AliFlux", "png", boundsArray, centerArray, minZoom, maxZoom, "mercator", 256 * outputScale)

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

			filePath = os.path.join(BASE_DIR, "output", outputDirectory, outputFile)

			self.writerByType(outputType).close(lock, os.path.join(BASE_DIR, "output", outputDirectory), filePath, minZoom, maxZoom)

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
			full_output_dir = os.path.join(BASE_DIR, "output", outputDirectory)

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
		default=int(os.environ.get("MTD_PORT", "8080")),
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
