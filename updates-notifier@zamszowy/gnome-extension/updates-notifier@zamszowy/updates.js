// Shared update-data model.
// Exported as an ES module – usable from the GNOME Shell extension process
// (extension.js) and from standalone GJS window scripts (info-window.js).
//
// All PackageKit info-enum constants are hard-coded here so that the optional
// PackageKitGlib GI typelib is not required at runtime.

// ---------------------------------------------------------------------------
// PackageKit PkInfoEnum constants (from pk-enum.h)
// ---------------------------------------------------------------------------
const PkInfo = Object.freeze({
    UNKNOWN:      0,
    INSTALLED:    1,
    AVAILABLE:    2,
    LOW:          3,
    ENHANCEMENT:  4,
    NORMAL:       5,
    BUGFIX:       6,
    IMPORTANT:    7,
    SECURITY:     8,
    BLOCKED:      9,
    DOWNLOADING:  10,
    UPDATING:     11,
    INSTALLING:   12,
    REMOVING:     13,
    CLEANUP:      14,
    OBSOLETING:   15,
    FINISHED:     18,
    REINSTALLING: 19,
    DOWNGRADING:  20,
    UNTRUSTED:    23,
    TRUSTED:      24,
});

// Reverse-lookup: integer → human-readable label stored in the updates file.
const PkInfoLabel = Object.freeze(
    Object.fromEntries(Object.entries(PkInfo).map(([k, v]) => [v, k.toLowerCase()]))
);

export const UpdateState = Object.freeze({
    BLOCKED:   'blocked',
    INSTALLED: 'installed',
    AVAILABLE: 'available',
    OTHER:     'other',
});

/**
 * Decode a raw PackageKit info-enum integer into [UpdateState, labelString].
 * Handles backends that pack the real value in the low/high 16-bit words.
 */
export function decodeUpdateState(code) {
    const tryDecode = (val) => {
        const label = PkInfoLabel[val];
        if (!label) return null;
        let state = UpdateState.OTHER;
        if (val === PkInfo.BLOCKED)        state = UpdateState.BLOCKED;
        else if (val === PkInfo.INSTALLED) state = UpdateState.INSTALLED;
        else if (val === PkInfo.AVAILABLE) state = UpdateState.AVAILABLE;
        return [state, label];
    };

    let res = tryDecode(code);
    if (!res) {
        const lo = code & 0xFFFF;
        const hi = (code >>> 16) & 0xFFFF;
        if (lo) res = tryDecode(lo);
        if (!res && hi) res = tryDecode(hi);
    }
    return res ?? [UpdateState.OTHER, UpdateState.OTHER];
}

// ---------------------------------------------------------------------------
// Updates – in-memory update catalogue
// ---------------------------------------------------------------------------

export class Updates {
    constructor() {
        /** @type {Map<string, object>} */
        this.map = new Map();
    }

    /**
     * Record one update package from a PackageKit D-Bus Package/Packages signal.
     * Returns true when the map entry was modified (triggers a UI refresh).
     */
    add(info, pkgid, summary) {
        const [state, infoStr] = decodeUpdateState(info);

        // BLOCKED / AVAILABLE rows are not ready-to-install; skip them.
        if (state === UpdateState.BLOCKED || state === UpdateState.AVAILABLE)
            return false;

        const tokens = pkgid.split(';');
        if (tokens.length < 4) return false;

        const [name, version, arch, repo] = tokens;

        if (state === UpdateState.INSTALLED) {
            // Second D-Bus row for the same package carrying the local version.
            if (this.map.has(name) && this.map.get(name).localVersion === '') {
                this.map.get(name).localVersion = version;
                return true;
            }
            return false;
        }

        // Everything else is a pending update.
        this.map.set(name, {
            isFirmware: '0',
            pkgid,
            version,
            localVersion: '',
            arch,
            repo,
            type: infoStr,
            description: summary,
        });
        return false;
    }

    /** Record a firmware update row obtained from fwupdmgr output. */
    addFirmware(name, deviceid, localVersion, version, description) {
        this.map.set(name, {
            isFirmware: '1',
            deviceid,
            localVersion,
            version,
            type: 'firmware',
            description,
        });
    }

    /** Serialise to a newline-separated flat text file (fields joined by '#'). */
    toStr() {
        let out = '';
        for (const [name, obj] of this.map) {
            if (obj.isFirmware === '0') {
                out += `${obj.isFirmware}#${name}#${obj.pkgid}#${obj.version}#${obj.localVersion}#${obj.arch}#${obj.repo}#${obj.type}#${obj.description}\n`;
            } else {
                out += `${obj.isFirmware}#${name}#${obj.deviceid}#${obj.version}#${obj.localVersion}#${obj.type}#${obj.description}\n`;
            }
        }
        return out;
    }

    /** Deserialise from text produced by toStr(). */
    static fromStr(str) {
        const updates = new Updates();
        for (let line of str.split('\n')) {
            if (!(line = line.trim())) continue;
            const tokens = line.split('#');
            if (!tokens?.length || !tokens[0]) continue;
            if (tokens[0] !== '0' && tokens[0] !== '1') continue;
            if (tokens[0] === '0' && tokens.length < 9) continue;
            if (tokens[0] === '1' && tokens.length < 7) continue;

            if (tokens[0] === '0') {
                const [, name, pkgid, version, localVersion, arch, repo, type, description]
                    = tokens.map(t => t.trim());
                updates.map.set(name, { pkgid, version, localVersion, arch, repo, type, description, isFirmware: '0' });
            } else {
                const [, name, deviceid, version, localVersion, type, description]
                    = tokens.map(t => t.trim());
                updates.map.set(name, { deviceid, version, localVersion, type, description, isFirmware: '1' });
            }
        }
        return updates;
    }
}
