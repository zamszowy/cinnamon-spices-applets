// Shared update-data model.
// Exported as an ES module – usable from the GNOME Shell extension process
// (extension.js) and from standalone GJS window scripts (info-window.js).
//
// All PackageKit info-enum constants are hard-coded here so that the optional
// PackageKitGlib GI typelib is not required at runtime.

// PkRoleEnum – only the value we care about
const PK_ROLE_GET_UPDATES = 9;

const PkInfo = Object.freeze({
    UNKNOWN: 0,
    INSTALLED: 1,
    AVAILABLE: 2,
    LOW: 3,
    ENHANCEMENT: 4,
    NORMAL: 5,
    BUGFIX: 6,
    IMPORTANT: 7,
    SECURITY: 8,
    BLOCKED: 9,
    DOWNLOADING: 10,
    UPDATING: 11,
    INSTALLING: 12,
    REMOVING: 13,
    CLEANUP: 14,
    OBSOLETING: 15,
    COLLECTION_INSTALLED: 16,
    COLLECTION_AVAILABLE: 17,
    FINISHED: 18,
    REINSTALLING: 19,
    DOWNGRADING: 20,
    PREPARING: 21,
    DECOMPRESSING: 22,
    UNTRUSTED: 23,
    TRUSTED: 24,
    UNAVAILABLE: 25,
    CRITICAL: 26,
    INSTALL: 27,
    REMOVE: 28,
    OBSOLETE: 29,
    DOWNGRADE: 30,
    LAST: 31,
});

// Reverse-lookup: integer → human-readable label stored in the updates file.
const PkInfoLabel = Object.freeze(
    Object.fromEntries(Object.entries(PkInfo).map(([k, v]) => [v, k.toLowerCase()]))
);

export const UpdateState = Object.freeze({
    BLOCKED: 'blocked',
    INSTALLED: 'installed',
    AVAILABLE: 'available',
    OTHER: 'other',
});


// Decode a raw PackageKit info-enum integer into [UpdateState, labelString].
// Handles backends that pack the real value in the low/high 16-bit words.
export function decodeUpdateState(code) {
    const tryDecode = (val) => {
        const label = PkInfoLabel[val];
        if (!label) return null;
        let state = UpdateState.OTHER;
        if (val === PkInfo.BLOCKED) state = UpdateState.BLOCKED;
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

export class Updates {
    constructor() {
        /** @type {Map<string, object>} */
        this.map = new Map();

        // D-Bus object paths of PackageKit transactions whose Role was reported as
        // PK_ROLE_ENUM_GET_UPDATES (9).  On backends like Fedora/DNF, updates are
        // emitted with PkInfo.AVAILABLE on those transactions instead of an update
        // variant, so we use the role to distinguish them from the generic package list.
        /** @type {Set<string>} */
        this._getUpdatesPaths = new Set();
    }

    /**
     * Record the role of a PackageKit transaction D-Bus object path.
     * Should be called from the org.freedesktop.DBus.Properties.PropertiesChanged
     * signal handler whenever the 'Role' property changes.
     *
     * @param {string} path     D-Bus object path, e.g. '/3682_bdddcace'
     * @param {number} roleVal  Numeric PkRoleEnum value
     */
    recordRole(path, roleVal) {
        if (roleVal === PK_ROLE_GET_UPDATES)
            this._getUpdatesPaths.add(path);
    }

    /**
     * Record one update package from a PackageKit D-Bus Package/Packages signal.
     * Returns true when the map entry was modified (triggers a UI refresh).
     *
     * @param {number} info     PkInfoEnum value from the D-Bus signal
     * @param {string} pkgid    PackageKit package-id string
     * @param {string} summary  Package summary / description
     * @param {string|null} path  D-Bus object path of the owning transaction.
     *   When the path was previously registered via recordRole() with
     *   Role=GET_UPDATES, AVAILABLE packages are treated as real updates.
     *   This is needed on Fedora/DNF where pending updates are reported as
     *   AVAILABLE rather than an update variant.
     */
    add(info, pkgid, summary, path = null) {
        const [state, infoStr] = decodeUpdateState(info);
        const forceUpdate = path !== null && this._getUpdatesPaths.has(path);

        // BLOCKED rows are never ready-to-install; always skip.
        if (state === UpdateState.BLOCKED)
            return false;

        // AVAILABLE rows are normally skipped (installable packages, not updates).
        // Exception: the transaction had Role=GetUpdates(9), meaning the backend is
        // intentionally reporting these as updates (common on Fedora/DNF).
        if (state === UpdateState.AVAILABLE && !forceUpdate)
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
