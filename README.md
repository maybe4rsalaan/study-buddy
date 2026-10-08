# Study Buddy

A full-screen study workspace that runs as a static website, installable web app, or Chrome/Edge extension.

Live site: https://maybe4rsalaan.github.io/study-buddy/

## Student features

- Organize courses with colors, short codes, and notes
- Add, update, complete, and delete assignments, exams, readings, projects, and study goals
- Set deadlines, priority, estimated effort, notes, and weekly recurrence
- Generate the next week's item when a recurring task is completed
- See an at-a-glance dashboard, weekly calendar, overdue items, and deadline-aware work list
- Upload PDFs, slides, documents, images, and other study files; attach them to a course and optionally a task
- Search courses, tasks, and materials
- Use a focus timer with short breaks and a session history
- Set daily deadline reminders and back up/restore courses and tasks
- Use the core workspace offline after the first visit

## Privacy and storage

This is a device-first app. The public site does not create accounts or send course details or uploaded files to a server. On the website, tasks and courses are saved in that browser's local storage and uploaded files are saved in IndexedDB. In the extension, tasks and courses use extension storage, files use extension IndexedDB, and a background alarm can show reminders while the extension is installed and the browser is running.

Each browser profile/device has its own copy. Use **Settings & backup** to move courses and tasks; uploaded files are not included in backups. Site notifications need permission and can run only while the website remains open. The extension's alarms work in the background while the browser is open.

This version does not connect to an AI model. It needs no API key and makes no network requests for student data.

## Use the website

Open the published GitHub Pages site in a modern browser. You can install it as a standalone web app from the browser menu. Each person gets an empty workspace and adds their own courses, tasks, and files.

## Install the Chrome/Edge extension

1. Download the repository with **Code → Download ZIP** and unzip it. (Or use the separate `study-buddy-extension.zip` package when one is provided.)
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Turn on **Developer mode** and choose **Load unpacked**.
4. Select the unzipped `study-buddy-extension` folder.
5. Select the unzipped repository root (the folder containing `manifest.json`) and pin Study Buddy. Clicking its icon opens the full-screen workspace in a new tab.

The extension requests local storage, alarms, and notification permissions for its tracker and reminders. It does not request access to websites you visit. Clicking the extension icon opens its full-screen dashboard in a new tab.

## Publish with GitHub Pages

The repository includes a GitHub Actions workflow at `.github/workflows/deploy-pages.yml`. After pushing the `main` branch to a public repository, open **Settings → Pages** and set **Build and deployment** to **GitHub Actions** if Pages has not been enabled already. The workflow publishes this repository root as a static site.

## Local files

- `index.html`, `app.css`, `app.js`: shared full-screen study workspace
- `manifest.json`, `background.js`, `icon.png`: Chrome/Edge extension behavior and reminders
- `web-manifest.json`, `service-worker.js`: installable offline web app
- `study-buddy-extension.zip`: ready-to-load extension folder
