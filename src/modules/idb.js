import { logger } from './logger.js';

const DB_NAME = 'shot_history';
const DB_VERSION = 8;
const SHOTS_STORE_NAME = 'shots';
const SETTINGS_STORE_NAME = 'settings';
const EMAILS_STORE_NAME = 'decent_emails';

let db;
let openPromise = null;

export function openDB() {
    logger.debug('openDB called.');

    if (db) {
        logger.debug('DB already open, returning existing instance.');
        return Promise.resolve(db);
    }

    if (openPromise) {
        logger.debug('DB opening in progress, returning existing promise.');
        return openPromise;
    }

    logger.debug('No existing DB instance or open promise, creating new open promise.');
    openPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
            logger.error('IndexedDB is not supported in this browser.');
            openPromise = null;
            return reject('IndexedDB not supported.');
        }

        logger.debug(`Requesting IndexedDB.open with name: ${DB_NAME}, version: ${DB_VERSION}`);
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onblocked = () => {
            // This event can happen if another tab has an older version of the DB open.
            logger.warn('IndexedDB open request is blocked. Please close other tabs with this app open.');
        };

        request.onerror = (event) => {
            logger.error('IndexedDB error:', event.target.error);
            openPromise = null; // Clear promise on error
            reject('Error opening IndexedDB.');
        };

        request.onsuccess = (event) => {
            logger.debug('IndexedDB open request.onsuccess event fired.');
            db = event.target.result;

            // This is a good practice to handle cases where the DB is deleted
            // or schema is updated from another tab.
            db.onversionchange = () => {
                db.close();
                logger.warn("Database version change detected, closing connection. Please reload the page.");
                alert("A new version of the database is required. Please reload the page.");
            };

            logger.info('IndexedDB opened successfully.');
            openPromise = null; // Clear promise on success
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            logger.debug('IndexedDB open request.onupgradeneeded event fired.');
            const tempDb = event.target.result;
            const upgradeTransaction = event.target.transaction;
            let shotsStore;
            if (!tempDb.objectStoreNames.contains(SHOTS_STORE_NAME)) {
                logger.info('Creating shots object store');
                shotsStore = tempDb.createObjectStore(SHOTS_STORE_NAME, { keyPath: 'id' });
            } else {
                shotsStore = upgradeTransaction.objectStore(SHOTS_STORE_NAME);
            }
            // Every shot record already carries `timestamp` -- index it so the
            // newest cached shot can be read with one indexed cursor instead of
            // getAllShots() (reads the whole store just to find the max).
            if (!shotsStore.indexNames.contains('by_timestamp')) {
                logger.info('Creating by_timestamp index on shots store');
                shotsStore.createIndex('by_timestamp', 'timestamp');
            }
            if (!tempDb.objectStoreNames.contains(SETTINGS_STORE_NAME)) {
                logger.info('Creating settings object store');
                tempDb.createObjectStore(SETTINGS_STORE_NAME, { keyPath: 'id' });
            }
            if (tempDb.objectStoreNames.contains(EMAILS_STORE_NAME)) {
                tempDb.deleteObjectStore(EMAILS_STORE_NAME);
            }
            logger.info('Creating decent_emails object store');
            tempDb.createObjectStore(EMAILS_STORE_NAME, { keyPath: 'emailid' });
        };
    });
    return openPromise;
}

export function setSetting(key, value) {
    return new Promise((resolve, reject) => {
        if (!db) return reject('DB not open');
        const transaction = db.transaction([SETTINGS_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(SETTINGS_STORE_NAME);
        const request = store.put({ id: key, value: value });
        request.onsuccess = () => resolve();
        request.onerror = (event) => {
            logger.error(`Error setting key "${key}" in IndexedDB:`, event.target.error);
            reject(`Error setting key "${key}"`);
        };
    });
}

export function getSetting(key) {
    return new Promise((resolve, reject) => {
        if (!db) return reject('DB not open');
        const transaction = db.transaction([SETTINGS_STORE_NAME], 'readonly');
        const store = transaction.objectStore(SETTINGS_STORE_NAME);
        const request = store.get(key);
        request.onsuccess = (event) => {
            resolve(event.target.result ? event.target.result.value : undefined);
        };
        request.onerror = (event) => {
            logger.error(`Error getting key "${key}" from IndexedDB:`, event.target.error);
            reject(`Error getting key "${key}"`);
        };
    });
}


export function addShot(shot) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        const transaction = db.transaction([SHOTS_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(SHOTS_STORE_NAME);
        const request = store.put(shot);

        request.onsuccess = () => {
            logger.info('Shot added to IndexedDB');
            resolve();
        };

        request.onerror = (event) => {
            logger.error('Error adding shot to IndexedDB:', event.target.error);
            reject('Error adding shot.');
        };
    });
}

// Bulk write, one transaction/commit for the whole page instead of one
// transaction per shot -- addShot() in a loop serializes N separate commits.
export function addShots(shotsArray) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        if (!shotsArray || shotsArray.length === 0) {
            return resolve();
        }
        const transaction = db.transaction([SHOTS_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(SHOTS_STORE_NAME);
        for (const shot of shotsArray) {
            store.put(shot);
        }

        transaction.oncomplete = () => {
            logger.info(`${shotsArray.length} shots added to IndexedDB in one transaction`);
            resolve();
        };

        transaction.onerror = (event) => {
            logger.error('Error bulk-adding shots to IndexedDB:', event.target.error);
            reject('Error bulk-adding shots.');
        };
    });
}

// Single most-recent cached shot via the by_timestamp index -- an indexed
// cursor, not a full-store read like getAllShots(). Used to paint the chart
// instantly on boot from whatever's already local, before the network fetch
// (which may reveal a newer shot) resolves.
export function getLatestCachedShot() {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        const transaction = db.transaction([SHOTS_STORE_NAME], 'readonly');
        const store = transaction.objectStore(SHOTS_STORE_NAME);
        const cursorRequest = store.index('by_timestamp').openCursor(null, 'prev');

        cursorRequest.onsuccess = (event) => {
            const cursor = event.target.result;
            resolve(cursor ? cursor.value : null);
        };

        cursorRequest.onerror = (event) => {
            logger.error('Error getting latest cached shot from IndexedDB:', event.target.error);
            reject('Error getting latest cached shot.');
        };
    });
}

export function getAllShots() {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        const transaction = db.transaction([SHOTS_STORE_NAME], 'readonly');
        const store = transaction.objectStore(SHOTS_STORE_NAME);
        const request = store.getAll();

        request.onsuccess = (event) => {
            resolve(event.target.result);
            logger.info("getAllShots success")
        };

        request.onerror = (event) => {
            logger.error('Error getting all shots from IndexedDB:', event.target.error);
            reject('Error getting shots.');
        };
    });
}

export function getLatestShotTimestamp() {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        const transaction = db.transaction([SHOTS_STORE_NAME], 'readonly');
        const store = transaction.objectStore(SHOTS_STORE_NAME);
        const cursorRequest = store.openCursor(null, 'prev');

        let latestTimestamp = 0;

        cursorRequest.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                latestTimestamp = cursor.value.timestamp;
                resolve(latestTimestamp);
            } else {
                resolve(null); // No shots in the database
            }
        };

        cursorRequest.onerror = (event) => {
            logger.error('Error getting latest shot timestamp:', event.target.error);
            reject('Error getting latest shot timestamp.');
        };
    });
}

export function getShot(id) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        const transaction = db.transaction([SHOTS_STORE_NAME], 'readonly');
        const store = transaction.objectStore(SHOTS_STORE_NAME);
        const request = store.get(id);

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            logger.error('Error getting shot from IndexedDB:', event.target.error);
            reject('Error getting shot.');
        };
    });
}

export function deleteShot(id) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        const transaction = db.transaction([SHOTS_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(SHOTS_STORE_NAME);
        const request = store.delete(id);

        request.onsuccess = () => {
            logger.info('Shot deleted from IndexedDB');
            resolve();
        };

        request.onerror = (event) => {
            logger.error('Error deleting shot from IndexedDB:', event.target.error);
            reject('Error deleting shot.');
        };
    });
}

export function clearShots() {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        const transaction = db.transaction([SHOTS_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(SHOTS_STORE_NAME);
        const request = store.clear();

        request.onsuccess = () => {
            logger.info('Shot history cleared from IndexedDB');
            resolve();
        };

        request.onerror = (event) => {
            logger.error('Error clearing shot history from IndexedDB:', event.target.error);
            reject('Error clearing shot history.');
        };
    });
}

export function addEmails(emails) {
    return new Promise((resolve, reject) => {
        if (!db) return reject('DB not open');
        const transaction = db.transaction([EMAILS_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(EMAILS_STORE_NAME);
        emails.forEach(email => store.put(email));
        transaction.oncomplete = () => resolve();
        transaction.onerror = (event) => reject(event.target.error);
    });
}

export function getAllEmails() {
    return new Promise((resolve, reject) => {
        if (!db) return reject('DB not open');
        const transaction = db.transaction([EMAILS_STORE_NAME], 'readonly');
        const store = transaction.objectStore(EMAILS_STORE_NAME);
        const request = store.getAll();
        request.onsuccess = (event) => {
            const emails = event.target.result || [];
            emails.sort((a, b) => (a.now || 0) - (b.now || 0));
            resolve(emails);
        };
        request.onerror = (event) => reject(event.target.error);
    });
}

export function getLatestEmailTimestamp() {
    return new Promise((resolve, reject) => {
        if (!db) return reject('DB not open');
        const transaction = db.transaction([EMAILS_STORE_NAME], 'readonly');
        const store = transaction.objectStore(EMAILS_STORE_NAME);
        const request = store.getAll();
        request.onsuccess = (event) => {
            const emails = event.target.result || [];
            if (!emails.length) return resolve(null);
            resolve(Math.max(...emails.map(e => e.now || 0)));
        };
        request.onerror = (event) => reject(event.target.error);
    });
}