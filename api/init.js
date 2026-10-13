import os from 'os';
import util from 'util';
import { exec } from 'node:child_process';
import { stderr } from 'node:process';

const execPromise = util.promisify(exec);

async function execCommand(command, stdout) {
    if (stdout) {
        console.log("Execute Command: " + command);
    }
    try {
        const { stdout, stderr } = await execPromise(command);
        const result = stdout.trim();
        console.log(result);
        return 
    } catch (error) {
        if (stderr) {
            console.error("Error: " + stderr.stderr);
        } else if (error.message) {
            console.error("Error: " + error.message);
        }
        return false;
    }
}

function checkLXD() {
    var version = execCommand("lxc version");
    var info = execCommand("lxc info");
    var networkList = execCommand("lxc network list");
    var storageList = execCommand("lxc storage list");

    // if(version)
}

execCommand("explorer.exe", true);