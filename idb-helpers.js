export function requestToPromise(request, mapResult = (result) => result) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(mapResult(request.result));
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

export function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };

    transaction.onerror = () => {
      reject(transaction.error);
    };
  });
}

export async function withStore(initDB, storeName, mode, handler) {
  const db = await initDB();
  const transaction = db.transaction(storeName, mode);
  const store = transaction.objectStore(storeName);
  const result = handler(store, transaction);

  if (mode === 'readwrite') {
    await transactionToPromise(transaction);
  }

  return result;
}