import sqlite3
import os
import multiprocessing
import io
import json
import shutil

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

class FileWriter:

	slicer = None
	
	def ensureDirectory(lock, directory):

		lock.acquire()
		try:

			os.makedirs(os.path.join(BASE_DIR, "temp"), exist_ok=True)
			os.makedirs(os.path.join(BASE_DIR, "output"), exist_ok=True)
			os.makedirs(directory, exist_ok=True)

		finally:
			lock.release()

		return directory

	@staticmethod
	def addMetadata(lock, path, file, name, description, format, bounds, center, minZoom, maxZoom, profile="mercator", tileSize=256, tileScheme="xyz"):

		FileWriter.ensureDirectory(lock, path)

		data = [
			("name", name),
			("description", description),
			("format", format), 
			("bounds", ','.join(map(str, bounds))), 
			("center", ','.join(map(str, center))), 
			("minzoom", minZoom), 
			("maxzoom", maxZoom), 
			("profile", profile), 
			("tilesize", str(tileSize)), 
			("scheme", tileScheme),
			("generator", "EliteMapper by Visor Dynamics"),
			("type", "overlay"),
			("attribution", "EliteMapper by Visor Dynamics"),
		]
		
		with open(os.path.join(path, "metadata.json"), 'w+') as jsonFile:
			json.dump(dict(data), jsonFile)

		return

	@staticmethod
	def addTile(lock, filePath, sourcePath, x, y, z, outputScale, tileScheme="xyz"):

		fileDirectory = os.path.dirname(filePath)
		FileWriter.ensureDirectory(lock, fileDirectory)
		
		shutil.copyfile(sourcePath, filePath)

		return

	@staticmethod
	def exists(filePath, x, y, z, tileScheme="xyz"):
		return os.path.isfile(filePath)


	@staticmethod
	def close(lock, path, file, minZoom, maxZoom, tileScheme="xyz"):
		#TODO recalculate bounds and center
		return
