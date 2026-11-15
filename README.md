# VisionTest

A computer vision app that runs on your own computer. It uses a built-in webcam, an external camera, or an uploaded video.

| Screen | What it does |
|---|---|
| **People counter** | Tracks each person, counts unique people, counts line crossings (in and out), and measures time in an area that you draw. |
| **Motion capture** | Captures the body movement of one or two people without markers and applies it to 3D characters: skeleton, solid body, rigged mesh, or your own `.glb` model. Records motion and exports it for Blender. |
| **Insights** | Dashboard for each saved counting session: totals, people over time, line crossings, a heatmap, and an event log. CSV download. |

## Start the app

You need [Python](https://www.python.org/downloads/) 3.10 to 3.13. On Windows, tick "Add Python to PATH" in the installer.

- **Mac or Linux:** open Terminal in this folder and run `./start.sh`
- **Windows:** double-click `start.bat`

The first start installs the libraries and takes a few minutes. Then the app opens at <http://localhost:8000>. Use Chrome or Edge. To stop the app, close the terminal window.

## How to use it

**People counter**
1. Select **Use camera** or **Upload video**. Select an external camera from the camera list.
2. Optional: select **Draw line** and click two points. For an eye-level camera, a vertical line across a doorway or walkway works best. The coral arrow shows the "in" direction. **Flip direction** reverses it.
3. Optional: select **Draw area** and click the corners. Click the first point to close the area.
4. Select **Start counting**. Select **Stop and save** to end. An uploaded video stops at its end.
5. Open **Insights** to see the results.

**Motion capture**
1. Select a source. Stand so the camera sees your full body.
2. Select a character skin. For **Your model**, upload a `.glb` character with a Mixamo or Ready Player Me rig.
3. Select **Record motion**. Select it again to stop.
4. Select **Export for Blender**. You get one `.bvh` file for each person. **Raw data** saves the body points as JSON.

**Open the motion in Blender**
1. In Blender, select **File > Import > Motion Capture (.bvh)**.
2. Select the file. Keep the default settings (Forward: -Z, Up: Y).
3. Press Space to play. The skeleton moves at 30 frames per second, and its size is in metres.

## How it works

- `app/tracker.py`: [YOLO11](https://docs.ultralytics.com) finds people. [Supervision](https://github.com/roboflow/supervision) and its companion package [Trackers](https://github.com/roboflow/trackers) give each person an ID (ByteTrack), count line crossings (`LineZone`), and check the area (`PolygonZone`).
- `app/main.py`: the local web server (FastAPI). The browser sends video frames. The server returns the people it found.
- `app/store.py`: saves sessions in `data/visiontest.db` (SQLite).
- `static/`: the web interface. Motion capture runs in the browser with MediaPipe Pose and three.js. `static/js/bvh.js` writes the Blender file.

## Good to know

- **Privacy:** video stays on your computer. The app does not identify faces. If you film other people, follow your local privacy rules.
- **Accuracy:** "unique people" counts tracking IDs. A person who leaves the view and comes back gets a new ID.
- **Motion capture** follows up to two people. It works best when they do not overlap in the picture.
- **Eye-level cameras:** people are tracked by body centre, because feet are often hidden. People who walk behind other people can get a new ID.
- **Licences:** Ultralytics YOLO uses the AGPL-3.0 licence. This is fine for tests. Commercial use needs an Ultralytics licence or a different detector. The sample character (`static/models/xbot.glb`) comes from the three.js examples.
