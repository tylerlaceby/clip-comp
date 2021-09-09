import { app, ipcMain, BrowserWindow } from "electron";
import * as storage from "electron-json-storage";
import { createWriteStream } from "fs";
import { join } from "path";
import {user_select_multiple_files, user_select_destination} from "./backend/dialog/user_select";
import { check_files_for_valid_type } from "./backend/file/checks";
// import "./backend/compression/compressin_handler";
import { get } from "https";
import { Work_Queue } from "./backend/compression/workQueue";
import EventEmitter from "events";
import { ChildProcess, fork } from "child_process";
import { existsSync } from "fs";
import ffprobe from "ffprobe";
import * as ffprobeLoaction from "ffprobe-static";
const pathToFfmpeg = process.env.APPDATA + "/ffmpeg.exe";
const events = new EventEmitter();
const work = new Work_Queue();
import { autoUpdater } from 'electron-updater';
autoUpdater.autoInstallOnAppQuit = true;

events.addListener("work/finished-compressing", onFinished);
events.addListener("work/started-compression", onStartingNewWork);

const FFMPEG_LOCATION_HTTPS = "https://clip-compressor.herokuapp.com/download/win";
// import electronReload from "electron-reload";
// electronReload(join(__dirname, '..'), {});

let window: BrowserWindow;

app.whenReady().then(async () => {
    await checkForValidInstall();
    main()
});

async function main () {

    window = new BrowserWindow({
        icon: "icon.ico",
        width: 800, height: 650,
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: __dirname + "/backend/bridge.js",
            devTools: true
        }
    });

    window.webContents.openDevTools()
    window.loadFile(join(__dirname, '..', 'index.html'));
    window.on("ready-to-show", window.show);
}

// Application IPC CALLS

ipcMain.handle("get/version", async () => {
    return app.getVersion();
});




/// Window Related APP CALLS



// Work Related Calls

ipcMain.handle("user/select/video-files", async () => {

    // get user selection of files.

    const user_selected = await user_select_multiple_files();

    // check for cancel of null array
    if (user_selected.canceled || user_selected.filePaths.length == 0) return [];

    // then check the files before sending them back as VALID

    const valid_selections = await check_files_for_valid_type(user_selected.filePaths);

    return valid_selections;
    // return either empty array for bad /invalid selection or files 
    // that are compressable

});

ipcMain.handle("user/select/destination", async () => {
    const user_selected = await user_select_destination ();

    // check for cancel of null array
    if (user_selected.canceled || user_selected.filePaths.length == 0) return undefined;
    else return user_selected.filePaths;
});

///Work QUEUE
ipcMain.handle("push/compression/new-work", async (_, work_data: WorkProperties[]) => {
    let previousSize = work.count;
    let all = work.push(work_data);

    // means no work is being done.
    if (previousSize === 0) {
        events.emit("work/started-compression", work.current);
    }

    return all;
});


async function onFinished (finished: WorkProperties) {
    let nextToDo = work.next();
    if (nextToDo) events.emit("work/started-compression", work.current);

    console.log("Queue Count: " + work.count)



    if (work.count > 0) {
        window.webContents.send("/work-update/one-done", work.get());
    } else window.webContents.send("/work-update/all-done", work.get());
}

async function onStartingNewWork (current: WorkProperties) {
    try {
        window.webContents.send("/work-update/starting-new", work.get())
    } catch (err) {
        console.log(err);
    }
    console.log("starting... \n");

    let compressionTask = compressFile(current);

    compressionTask.then((finished) => {
        events.emit("work/finished-compressing", finished);
    })

    compressionTask.catch((err) => {
        events.emit("work/finished-compressing", current);
        console.log("FAILED TOP Compress FILE" + err)
    })
}


async function compressFile (file: WorkProperties) {
    return new Promise<WorkProperties>((res, rej) => {
        const thread = fork(__dirname + "/backend/compression/compressionWorker");
        let totalFrames = 0;

        if (existsSync(pathToFfmpeg)) { 
            ffprobe(file.file.path, ({path: ffprobeLoaction.path}), (err, info) => {
                if (err) console.log(err);
                else {
                    totalFrames = info.streams[0].nb_frames || 0;
                    
                }

                thread.send({data: file});
            });

            thread.on("message", (message: {completed: boolean, err: boolean, frameCompleted: number}) => {
                
                if (message.completed && !message.err) {
                    thread.kill();
                    res(file);
                } else if (!message.completed && message.err){
                    res(file)
                    thread.kill();
                } else {    
                     
                    const progress = message.frameCompleted / totalFrames;
                    window.webContents.send("/update-progress", progress);
                }
            });
            
            thread.on("error", (error) => {
                console.log(error);
                rej(error);
            });
            
            thread.on("exit", (exitCode) => {
                console.log(`Process: exited ecode: ${exitCode}`);
            });

        }
    })
}


ipcMain.handle("get/valid-install", async() => {
    let installedPath = await checkForValidInstall();

    return installedPath;
})


// Handle Iniit

async function checkForValidInstall () {
    return new Promise((res, rej) => {
        storage.get("ffmpeg-path", async (err, data: any) => {
            if (err) {
                rej(err)
            }

            console.log(data.path + " path from storage");
            if (data.path) res(data.path);
            else {
                let newPath = await installFFMPEG ();
                storage.set("ffmpeg-path", {path: newPath} , (err) => {
                    if (err) {
                        rej(err);
                    }
                    res(newPath);
                })
            }
        })
    })
}


async function installFFMPEG () {
    const defaultPathToFFMPEG = app.getPath("appData") + "/ffmpeg.exe";
    return new Promise((success, reject) => {
            console.log("making https request")
            const file = createWriteStream(defaultPathToFFMPEG);
            
            get(FFMPEG_LOCATION_HTTPS, (response) => {
                response.pipe(file);
                file.on("finish", () => {
                    console.log("pipe finished")
                    success(defaultPathToFFMPEG);
                })

                response.on("error", (e: any) => {
                    console.log(e)
                    reject(e);
                });

            });
    })
}




// Updater Stuffz

// Check for application update every 30s
setInterval(() => {
    try {
        autoUpdater.checkForUpdatesAndNotify();
    } catch(err) {
        console.log(err);
        console.log('failed to search for autoUpdater')
    }
    
}, 30000)

autoUpdater.on("update-downloaded", (e) => {
    window.webContents.send("update-downloaded", "an update was downloaded and will be installed when you restart the app.")
});

autoUpdater.on("update-available", (e) => {
    window.webContents.send("update-found", "starting update now")
});