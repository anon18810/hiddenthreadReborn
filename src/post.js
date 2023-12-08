let Utils = require('./utils.js')
let Crypto = require('./crypto.js')
let Stegano = require('./stegano.js')
let JSZip = require('../lib/jszip.min.js')

const NORMAL_POST_TYPE = 0;
const SIGNED_POST_TYPE = 1;

const MESSAGE_MAX_LENGTH = 30000
const MAX_FILES_COUNT = 9;
const MAX_FILENAME_LENGTH = 20;

function calcContainerSize(container, ratio, dataLength, pixelCount) {
    let newPixelCount = dataLength / container.thresholdDataRatio / 3;
    let newWidth = Math.sqrt(newPixelCount * ratio);
    let newHeight = newWidth / ratio;

    let minValue = null;
    let minValueDeviance = null;
    let maxValue = null;
    let maxValueDeviance = null;
    if (container.pixelCountAdjust == 'pixelcount') {
        minValue = container.minPixelCount;
        minValueDeviance = container.minPixelCountDeviance;
        maxValue = container.maxPixelCount;
        maxValueDeviance = container.maxPixelCountDeviance;
    } else if (container.pixelCountAdjust == 'width') {
        minValue = container.minWidth;
        minValueDeviance = container.minWidthDeviance;
        maxValue = container.maxWidth;
        maxValueDeviance = container.maxWidthDeviance;
    } else if (container.pixelCountAdjust == 'height') {
        minValue = container.minHeight;
        minValueDeviance = container.minHeightDeviance;
        maxValue = container.maxHeight;
        maxValueDeviance = container.maxHeightDeviance;
    }
    const minValueDeviancePix = minValue * minValueDeviance;
    const maxValueDeviancePix = maxValue * maxValueDeviance;
    minValue = Utils.getRandomInRange(minValue - minValueDeviancePix, minValue + minValueDeviancePix);
    maxValue = Utils.getRandomInRange(maxValue - maxValueDeviancePix, maxValue + maxValueDeviancePix);

    if (container.pixelCountAdjust == 'pixelcount') {
        newPixelCount = Math.min(Math.max(newPixelCount, minValue), maxValue);
        newWidth = Math.sqrt(newPixelCount * ratio);
        newHeight = newWidth / ratio;
    } else if (container.pixelCountAdjust == 'width') {
        newWidth = Math.min(Math.max(newWidth, minValue), maxValue);
        newHeight = newWidth / ratio;
        newPixelCount = newWidth * newHeight;
    } else if (container.pixelCountAdjust == 'height') {
        newHeight = Math.min(Math.max(newHeight, minValue), maxValue);
        newWidth = newHeight * ratio;
        newPixelCount = newWidth * newHeight;
    }

    let newFillRatio = dataLength / (newPixelCount * 3);
    if (newFillRatio > container.maxDataRatio)
        return null;

    return {
        scale: Math.sqrt(newPixelCount / pixelCount),
        width: Math.ceil(newWidth),
        height: Math.ceil(newHeight),
    };
}

async function hideDataToImage(container, data) {
    let imageBitmap = await createImageBitmap(container.image);
    let pixelCount = imageBitmap.width * imageBitmap.height;
    let rgbCount = pixelCount * 3;
    let ratio = imageBitmap.width / imageBitmap.height;

    let scale = 1;
    if (container.isAdjustResolution) {
        let containerSize = calcContainerSize(container, ratio, data.length, pixelCount);
        if (!containerSize)
            throw new Error('Невозможно вместить данные в контейнер, необходимо увеличить '+
                'максимальный процент заполнения или выбрать большее разрешение.');
        scale = containerSize.scale;
    }
    else if (rgbCount < data.length) {
        let rest = Math.ceil((data.length - rgbCount) / 3);
        throw new Error('Невозможно вместить данные в контейнер, необходимо ещё ' +
            'как минимум ' + rest + ' пикселей. Выбери картинку с большим разрешением.');
    }

    let canvas = document.createElement('canvas');
    canvas.width = Math.ceil(imageBitmap.width * scale);
    canvas.height = Math.ceil(imageBitmap.height * scale);

    let ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.scale(scale, scale);
    ctx.drawImage(imageBitmap, 0, 0, imageBitmap.width, imageBitmap.height);
    let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Убираем прозрачность
    for (let i = 3; i < imageData.data.length; i+=4) {
        if (imageData.data[i] != 255) imageData.data[i] = 255;
    }
    let newImageData = await Stegano.hideDataToArray(imageData.data, data);
    for (let i = 0; i < newImageData.length; i++)
        imageData.data[i] = newImageData[i];
    ctx.putImageData(imageData, 0, 0);

    let percent = (data.length / (imageData.data.length / 4 * 3) * 100).toFixed(2);
    return { 'canvas': canvas, 'len': data.length, 'percent': percent };
}

function createHeader(type, totalLength) {
    let header = new Uint8Array(Crypto.BLOCK_SIZE);
    header.set(new TextEncoder().encode('ht'));
    let version = 0x01;
    header[2] = version & 0xFF;
    header[3] = (version >> 8) & 0xFF;
    let blocksCount = Math.ceil((Crypto.BLOCK_SIZE + totalLength + 1) / Crypto.BLOCK_SIZE);
    header[4] = blocksCount & 0xFF;
    header[5] = (blocksCount >> 8) & 0xFF;
    header[6] = (blocksCount >> 16) & 0xFF;
    header[7] = (blocksCount >> 24) & 0xFF;
    let time = Math.ceil(new Date().getTime() / 1000);
    header[8] = time & 0xFF;
    header[9] = (time >> 8) & 0xFF;
    header[10] = (time >> 16) & 0xFF;
    header[11] = (time >> 24) & 0xFF;
    header[12] = type;
    header[15] = 0x01; // PKCS#7 padding

    return header;
}

async function packPost(message, files, privateKey) {
    let zip = new JSZip();
    zip.file("_post.txt", message);
    for (let i = 0; i < files.length; i++) {
        let f = files[i];
        zip.file(f.name, f);
    }

    let archive = await zip.generateAsync({
        type: "uint8array",
        compression: "DEFLATE",
        compressionOptions: {
            level: 6 // [1..9]
        }
    });

    let data = null;
    // Если указан приватный ключ, подписываем пост
    if (privateKey.length > 0) {
        let header = createHeader(SIGNED_POST_TYPE, Crypto.PUBLIC_KEY_SIZE + Crypto.SIGNATURE_SIZE + archive.length);
        let publicKeyArray = Crypto.importPublicKeyArrayFromPrivateKey(privateKey);

        data = new Uint8Array(Crypto.BLOCK_SIZE + Crypto.PUBLIC_KEY_SIZE + Crypto.SIGNATURE_SIZE + archive.length);
        data.set(header);
        data.set(publicKeyArray, Crypto.BLOCK_SIZE);
        // Сигнатура будет вставлена после подписывания поста
        data.set(archive, Crypto.BLOCK_SIZE + Crypto.PUBLIC_KEY_SIZE + Crypto.SIGNATURE_SIZE);

        let signatureArray = await Crypto.sign(privateKey, data);
        if (signatureArray.length != Crypto.SIGNATURE_SIZE || publicKeyArray.length != Crypto.PUBLIC_KEY_SIZE) {
            Utils.trace('HiddenThread: signature and publicKey:');
            Utils.trace(signatureArray);
            Utils.trace(publicKeyArray);
            throw new Error("signatureArray or publicKeyArray size incorrect");
        }
        data.set(signatureArray, Crypto.BLOCK_SIZE + Crypto.PUBLIC_KEY_SIZE);
    }
    else {
        let header = createHeader(NORMAL_POST_TYPE, archive.length);
        data = new Uint8Array(header.length + archive.length);
        data.set(header);
        data.set(archive, header.length);
    }

    return data;
}

async function encryptPost(message, files, password, privateKey, otherPublicKey) {
    let oneTimePublicKey = null;
    if (otherPublicKey.length > 0) {
        // Создаем одноразовую пару ключей
        let pair = await Crypto.generateKeyPair();
        // Генерируем секрет с одноразовым приватным ключом и публичным ключом получателя
        password = await Crypto.deriveSecretKey(pair[0], otherPublicKey)
        // Получатель сгенерирует секрет нашим одноразовым публичным ключом и своим приватным
        oneTimePublicKey = Utils.base58ToArray(pair[1]);
    }

    let postData = await packPost(message, files, privateKey);

    let encryptedData = await Crypto.encrypt(password, postData);

    if (oneTimePublicKey != null) {
        // Вставляем одноразовый ключ в начало массива данных
        let keyAndData = new Uint8Array(oneTimePublicKey.length + encryptedData.length);
        keyAndData.set(oneTimePublicKey);
        keyAndData.set(encryptedData, oneTimePublicKey.length);
        encryptedData = keyAndData;
    }
    return { data: encryptedData, password: password };
}

async function getContainer(url) {
    let image = new Image();
    image.crossOrigin = "anonymous";
    try {
        image.src = url;
        await image.decode();
    } catch (e) {
        Utils.trace(`HiddenThread: ошибка при загрузке контейнера по ссылке "${image.src}": ${e}`);
        throw new Error('Не удалось загрузить контейнер по ссылке. Попробуйте ещё раз или выберите другую картинку.');
    }
    return image;
}

async function getRandomContainer(container, dataLength) {
    const RATIO = Utils.getRandomInRange(1.2, 2.0, true);

    let containerSize = calcContainerSize(container, RATIO, dataLength, 1);
    if (!containerSize)
        throw new Error('Невозможно вместить данные в контейнер, необходимо увеличить '+
            'максимальный процент заполнения или выбрать большее разрешение.');

    let width = containerSize.width;
    let height = containerSize.height;

    let image = new Image();
    image.crossOrigin = "anonymous";
    try {
        // ?x=... нужно для отключения кэша
        let nocache = `x=${Date.now()}`;
        if (container.pack == 0) {
            image.src = `https://picsum.photos/${width}/${height}?${nocache}`;
        } else if (container.pack == 1) {
            image.src = `https://random.imagecdn.app/${width}/${height}?${nocache}`;
        } else if (container.pack == 2) {
            image.src = `https://cataas.com/cat?${nocache}`;
        } else if (container.pack == 3) {
            let jsonUrl = `https://dog.ceo/api/breeds/image/random?${nocache}`;
            let response = await fetch(jsonUrl);
            if (!response.ok)
                throw new Error(`fetch not ok, url: ${jsonUrl}`);
            let obj = await response.json();
            if (!obj.status || obj.status !== 'success' || !obj.message)
                throw new Error(`wrong object: ${JSON.stringify(obj)}`);
            image.src = obj.message;
        } else if (container.pack == 4) {
            let jsonUrl = `https://api.waifu.pics/sfw/waifu?${nocache}`;
            let response = await fetch(jsonUrl);
            if (!response.ok)
                throw new Error(`fetch not ok, url: ${jsonUrl}`);
            let obj = await response.json();
            if (!obj.url)
                throw new Error(`wrong object: ${JSON.stringify(obj)}`);
            image.src = obj.url;
        }

        // Для картинок без родного разрешения отключаем подстройку, чтобы не масштабировать лишний раз
        if (container.pack == 0 || container.pack == 1) {
            container.isAdjustResolution = false
        }
        await image.decode();
    } catch (e) {
        Utils.trace(`HiddenThread: ошибка при загрузке случайного контейнера "${image.src}": ${e}`);
        if (container.pack == 4) {
            throw new Error('Не удалось загрузить случайный контейнер. Попробуйте ещё раз или выберите свою картинку.\n' +
                'Для загрузки с waifu.pics нужно установить расширение для обхода настроек CORS ' +
                '(для firefox - CORS Everywhere, для chrome - CORS Unblock)');
        } else {
            throw new Error('Не удалось загрузить случайный контейнер. Попробуйте ещё раз или выберите свою картинку.');
        }
    }
    return image;
}

async function createHiddenPostImpl(container, message, files, password, privateKey, otherPublicKey) {
    let encryptedPost = await encryptPost(message, files, password, privateKey, otherPublicKey);
    if (!container.image) {
        if (typeof(container.pack) == 'number') {
            container.image = await getRandomContainer(container, encryptedPost.data.length);
        } else if (container.url) {
            container.image = await getContainer(container.url);
        } else {
            throw new Error('Введите ссылку для загрузки контейнера!');
        }
    }
    let imageResult = await hideDataToImage(container, encryptedPost.data);

    return {
        imageResult: imageResult,
        password: encryptedPost.password,
        iv: encryptedPost.data.subarray(0, Crypto.IV_SIZE)
    };
}

async function getMimeType(blob) {
    function check(a, b) {
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }
    let data = new Uint8Array(await blob.slice(0,12).arrayBuffer());
    if (check([0x89, 0x50, 0x4E, 0x47], data)) {
        return 'image/png';
    } else if (check([0xFF, 0xD8, 0xFF], data)) {
        return 'image/jpeg';
    } else if (check([0x52, 0x49, 0x46, 0x46], data) && check([0x57, 0x45, 0x42, 0x50], data.slice(8, 12))) {
        return 'image/webp';
    } else if (check([0x49, 0x44, 0x33], data)) {
        return 'audio/mpeg';
    } else if (check([0x47, 0x49, 0x46], data)) {
        return 'image/gif';
    } else if (check([0x66, 0x74, 0x79, 0x70], data.slice(4, 8))) {
        return 'video/mp4';
    } else if (check([0x1A, 0x45, 0xDF, 0xA3], data)) {
        return 'video/webm';
    }
    return '';
}

async function unzipPostData(zipData) {
    let zip = new JSZip();

    let unpackResult = null;
    let hasSkippedFiles = false;
    let postMessage = '';
    let files = [];
    let filesCount = 0;
    try {
        let archive = await zip.loadAsync(zipData);
        // >>**** cute/18879-кун ****
		filesLength = Object.keys(archive.files).length;
        if (filesLength > MAX_FILES_COUNT)
        {
			return {
				'message': '',
				'files': [],
				'hasSkippedFiles': false,
				'unpackResult': "Анон наспамил " + filesLength + " файлов",
			};
        }
        // <<**** cute/18879-кун ****

        for (const filename in archive.files) {
            // >>**** cute/18879-кун ****
            if (archive.files[filename]._data.uncompressedSize / 1024 / 1024 > 20) {
                return {
                    'message': '',
                    'files': [],
                    'hasSkippedFiles': false,
                    'unpackResult': "Анон вкинул файл весом более 20мб",
                };
            }
            // <<**** cute/18879-кун ****
            filesCount++;
            if (filesCount > MAX_FILES_COUNT) {
                hasSkippedFiles = true;
                files.push({ 'name': '_allFiles.zip', 'data': new Blob([zipData], {type: 'application/zip'}) });
                break;
            }

            if (filename == '_post.txt') {
                postMessage = await archive.file(filename).async('string');
                if (postMessage.length > MESSAGE_MAX_LENGTH) {
                    postMessage = postMessage.substring(0, MESSAGE_MAX_LENGTH) +
                        '...(часть сообщения обрезана, смотри файл ' + filename + ')';
                    let postMessageFileData = await archive.file(filename).async('blob');
                    postMessageFileData = postMessageFileData.slice(0, postMessageFileData.size, 'text/plain; charset=utf-8');
                    files.push({ 'name': filename, 'data': postMessageFileData });
                }
            }
            else {
                let fileData = await archive.file(filename).async('blob');
                let mimeType = await getMimeType(fileData);
                if (mimeType) {
                    fileData = fileData.slice(0, fileData.size, mimeType);
                }
                files.push({'name': filename, 'data': fileData});
            }
        }
    }
    catch (e) {
        Utils.trace('HiddenThread: Ошибка при распаковке архива: ' + e);
        unpackResult = 'Не удалось распаковать весь пост, контейнер поврежден';
    }

    return {
        'message': postMessage,
        'files': files,
        'hasSkippedFiles': hasSkippedFiles,
        'unpackResult': unpackResult
    };
}

async function verifyPostData(data) {
    let keySigPair = [data.subarray(Crypto.BLOCK_SIZE, Crypto.BLOCK_SIZE + Crypto.PUBLIC_KEY_SIZE),
    // Копируем сигнатуру
    new Uint8Array(data.subarray(Crypto.BLOCK_SIZE + Crypto.PUBLIC_KEY_SIZE,
        Crypto.BLOCK_SIZE + Crypto.PUBLIC_KEY_SIZE + Crypto.SIGNATURE_SIZE))];

    // Обнуляем поле с сигнатурой, чтобы получить корректный хэш при проверке
    data.set(new Uint8Array(Crypto.SIGNATURE_SIZE), Crypto.BLOCK_SIZE + Crypto.PUBLIC_KEY_SIZE);

    let isVerified = false;
    try {
        isVerified = await Crypto.verify(keySigPair[0], keySigPair[1], data);
    }
    catch (e) {
        Utils.trace('HiddenThread: Ошибка при проверке подписи: ' + e + ' stack:\n' + e.stack);
    }
    let verifyResult = {
        'publicKey': Utils.arrayToBase58(keySigPair[0]),
        'signature': Utils.arrayToBase58(keySigPair[1]),
        'isVerified': isVerified
    };
    return verifyResult;
}

function parseHeader(header) {
    return {
        'magic': new TextDecoder().decode(header.subarray(0, 2)),
        'version': header[2] + (header[3] << 8),
        'blocksCount': header[4] + (header[5] << 8) + (header[6] << 16) + (header[7] << 24),
        'timestamp': header[8] + (header[9] << 8) + (header[10] << 16) + (header[11] << 24),
        'type': header[12]
    };
}

async function decryptData(password, hiddenDataHeader, imageArray, dataOffset) {
    let dataHeader = null;
    try {
        dataHeader = await Crypto.decrypt(password, hiddenDataHeader, true);
    }
    catch (e) {
        // Не удалось расшифровать заголовок, либо неверный пароль, либо это не скрытопост
        return null;
    }

    let header = parseHeader(dataHeader);
    if (header.magic != 'ht') {
        Utils.trace('HiddenThread: Неверная сигнатура: ' + header.magic);
        return null;
    }

    Utils.trace('HiddenThread: version ' + header.version);
    Utils.trace('HiddenThread: blocksCount ' + header.blocksCount);
    Utils.trace('HiddenThread: timestamp ' + header.timestamp);
    Utils.trace('HiddenThread: type ' + header.type);

    let maxHiddenDataLength = imageArray.length / 4 * 3;
    let hiddenDataLength = Crypto.IV_SIZE + header.blocksCount * Crypto.BLOCK_SIZE;
    Utils.trace('HiddenThread: hiddenDataLength (+IV) ' + hiddenDataLength);
    if (hiddenDataLength > maxHiddenDataLength) {
        Utils.trace('HiddenThread: blocksCount * Crypto.BLOCK_SIZE: ' + (header.blocksCount * Crypto.BLOCK_SIZE) + ' > maxHiddenDataLength: ' + maxHiddenDataLength);
        return null;
    }

    // Заголовок верный, расшифровываем остальной пост
    let hiddenDataSize = dataOffset + hiddenDataLength;
    let hiddenData = await Stegano.extractDataFromArray(imageArray, hiddenDataSize);
    hiddenData = hiddenData.subarray(dataOffset);

    let decryptedData = null;
    try {
        decryptedData = await Crypto.decrypt(password, hiddenData);
    }
    catch (e) {
        Utils.trace('HiddenThread: Не удалось расшифровать данные: ' + e);
        return null;
    }
    return {
        'header': header,
        'data': decryptedData
    };
}

async function getImageData(imgArrayBuffer) {
    let imgUint8Array = new Uint8Array(imgArrayBuffer);

    // Если есть sRGB chunk, то принудительно ставим "rendering intent" в "AbsoluteColorimetric",
    // чтобы при чтении значений пикселей возвращалось истинное значение цвета
    // https://bugzilla.mozilla.org/show_bug.cgi?id=867594
    if (imgUint8Array[0x25] == 0x73 && imgUint8Array[0x26] == 0x52 &&
        imgUint8Array[0x27] == 0x47 && imgUint8Array[0x28] == 0x42)
    {
        imgUint8Array[0x29] = 3;
    }

    let imgBlob = new Blob([imgUint8Array], {'type': 'image/png'});
    const img = new Image();
    await new Promise(function(resolve, reject) {
        img.onload = function(event) {
            URL.revokeObjectURL(event.target.src);
            resolve();
        }
        img.onerror = function(event) {
            reject(event);
        }
        img.src = URL.createObjectURL(imgBlob);
    });

    let canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    let ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// Возвращает объект скрытого поста
async function loadPostFromImage(imgArrayBuffer, passwords, privateKeys, myPrivatePosts) {
    let imageData = await getImageData(imgArrayBuffer);

    let hiddenDataHeader = null;
    let hiddenDataPrivatePostHeader = null;
    let rgbCount = imageData.data.length / 4 * 3;
    if (rgbCount < Crypto.IV_SIZE + Crypto.BLOCK_SIZE) {
        // Слишком маленький контейнер, это не скрытопост
        return null;
    } else if (rgbCount < Crypto.PUBLIC_KEY_SIZE + Crypto.IV_SIZE + Crypto.BLOCK_SIZE) {
        // Извлекаем заголовок для обычного скрытопоста (IV и первый блок AES)
        let hiddenDataHeaderSize = Crypto.IV_SIZE + Crypto.BLOCK_SIZE;
        hiddenDataHeader = await Stegano.extractDataFromArray(imageData.data, hiddenDataHeaderSize);
    } else {
        // Извлекаем заголовок для обычного скрытопоста (IV и первый блок AES)
        // и для приватного скрытопоста (одноразовый публичный ключ, IV и первый блок AES)
        let hiddenDataHeaderSize = Crypto.PUBLIC_KEY_SIZE + Crypto.IV_SIZE + Crypto.BLOCK_SIZE;
        hiddenDataPrivatePostHeader = await Stegano.extractDataFromArray(imageData.data, hiddenDataHeaderSize);
        hiddenDataHeader = hiddenDataPrivatePostHeader.subarray(0, Crypto.IV_SIZE + Crypto.BLOCK_SIZE);
    }


    let isPrivate = false;
    let decryptedData = null;
    let correctPassword = null;
    let correctPrivateKey = null;
    let otherPublicKey = null;
    let iv = hiddenDataHeader.subarray(0, Crypto.IV_SIZE);

    // Пробуем расшифровать как приватный пост, отправленный нами
    if (hiddenDataPrivatePostHeader) {
        for (let myPrivatePost of myPrivatePosts) {
            let ivMatch = true;
            for (let i = 0; i < Crypto.IV_SIZE; i++) {
                if (iv[i] != myPrivatePost.iv[i]) {
                    ivMatch = false;
                    break;
                }
            }
            if (!ivMatch) continue;
    
            decryptedData = await decryptData(myPrivatePost.password,
                hiddenDataPrivatePostHeader.subarray(Crypto.PUBLIC_KEY_SIZE),
                imageData.data, Crypto.PUBLIC_KEY_SIZE);
            if (decryptedData) {
                otherPublicKey = myPrivatePost.otherPublicKey;
                break;
            }
        }
    }

    if (decryptedData == null) {
        // Пробуем расшифровать как публичный пост
        for (let password of passwords) {
            decryptedData = await decryptData(password.value, hiddenDataHeader, imageData.data, 0);
            if (decryptedData) {
                correctPassword = password.value;
                break;
            }
        }
    }

    if (decryptedData == null && privateKeys.length > 0 && hiddenDataPrivatePostHeader) {
        isPrivate = true;
        // Генерируем секрет с одноразовым публичным ключом отправителя и своим приватным ключом
        let hiddenOneTimePublicKey = hiddenDataPrivatePostHeader.subarray(0, Crypto.PUBLIC_KEY_SIZE);
        let oneTimePublicKey = Utils.arrayToBase58(hiddenOneTimePublicKey);

        for (let privateKey of privateKeys) {
            let secretPassword = null;
            try {
                secretPassword = await Crypto.deriveSecretKey(privateKey.value, oneTimePublicKey);
            }
            catch (e) {
                // Не удалось сгенерировать секрет, либо неверный ключ, либо это не скрытопост
            }

            if (secretPassword) {
                // Пробуем расшифровать как приватный пост
                decryptedData = await decryptData(secretPassword,
                    hiddenDataPrivatePostHeader.subarray(Crypto.PUBLIC_KEY_SIZE),
                    imageData.data, Crypto.PUBLIC_KEY_SIZE);
                if (decryptedData) {
                    correctPrivateKey = privateKey.value;
                    break;
                }
            }
        }
    }

    // Расшифровать не получилось
    if (decryptedData == null) return null;

    let zipOffset = null;
    let verifyResult = null;
    if (decryptedData.header.type == SIGNED_POST_TYPE) {
        verifyResult = await verifyPostData(decryptedData.data);
        zipOffset = Crypto.BLOCK_SIZE + Crypto.PUBLIC_KEY_SIZE + Crypto.SIGNATURE_SIZE;
    }
    else {
        zipOffset = Crypto.BLOCK_SIZE;
    }

    let zipDataArray = decryptedData.data.subarray(zipOffset);
    let zipData = new Blob([zipDataArray], {type: 'application/zip'});

    return {
        password: correctPassword,
        privateKey: correctPrivateKey,
        otherPublicKey: otherPublicKey,
        timestamp: decryptedData.header.timestamp,
        publicKey: verifyResult ? verifyResult.publicKey : null,
        isVerified: verifyResult ? verifyResult.isVerified : null,
        isPrivate: isPrivate,
        zipData: zipData,
    };
}

async function createImagePreview(blobLink) {
    const MAX_PREVIEW_WIDTH = 200;
    const MAX_PREVIEW_HEIGHT = 300;
    let imagePreviewLink = document.createElement('a');
    let imagePreview = document.createElement('img');
    imagePreview.src = blobLink;
    try {
        await imagePreview.decode();
    } catch (e) {}
    imagePreviewLink.appendChild(imagePreview);
    imagePreview.style = `max-width:${MAX_PREVIEW_WIDTH}px;max-height:${MAX_PREVIEW_HEIGHT}px;`;
    imagePreviewLink.href = blobLink;
    imagePreviewLink.target = "_blank";

    function imagePreviewClickListener(e) {
        e.preventDefault();

        // Закрываем текущую картинку при открытии новой
        let prevImageExpandedDiv = document.getElementById('htImageExpanded');
        if (prevImageExpandedDiv) {
            prevImageExpandedDiv.remove();
            if (prevImageExpandedDiv.children[0].href == imagePreviewLink.href)
                return;
        }

        let imageExpanded = document.createElement('img');
        imageExpanded.src = blobLink;
        imageExpanded.style = 'width:inherit;height:inherit;border:2px solid #222;';

        let initLeft = window.innerWidth/2 - imageExpanded.width/2;
        let initTop = window.innerHeight/2 - imageExpanded.height/2;

        // Уменьшаем картинку сразу, если он не влезает в экран
        let initScale = 1;
        let widthFill = imageExpanded.width / window.innerWidth;
        let heightFill = imageExpanded.height / window.innerHeight;
        let maxFill = Math.max(widthFill, heightFill);
        if (maxFill > 0.8)
            initScale = 0.8 / maxFill;
        let scale = initScale;
    
        let imageExpandedDiv = document.createElement('div');
        imageExpandedDiv.id = 'htImageExpanded';
        imageExpandedDiv.style.zIndex = 0;
        imageExpandedDiv.style.left = `${initLeft}px`;
        imageExpandedDiv.style.top = `${initTop}px`;
        imageExpandedDiv.style.position = 'fixed';
        imageExpandedDiv.style.transform = `scale(${scale})`;

        let imageExpandedLink = document.createElement('a');
        imageExpandedLink.appendChild(imageExpanded);
        imageExpandedLink.style = 'width:inherit;height:inherit';
        imageExpandedLink.href = blobLink;
        imageExpandedLink.target = "_blank";
        imageExpandedLink.onclick = function(e) { e.preventDefault(); };

        // Зум картинки
        let wheelListener = function(e) {
            e.preventDefault();
            scale += e.deltaY * -0.005;
            scale = Math.min(Math.max(initScale*0.1, scale), initScale*10);
            imageExpandedDiv.style.transform = `scale(${scale})`;
        };
        imageExpanded.onwheel = wheelListener;
    
        let initialImageLeft = 0;
        let initialImageTop = 0;

        // Захват картинки для перетаскивания
        imageExpandedDiv.onmousedown = function(e) {
            e.preventDefault();
            initialImageLeft = imageExpandedDiv.style.left;
            initialImageTop = imageExpandedDiv.style.top;
    
            let offsetX = e.clientX - parseInt(imageExpandedDiv.style.left.slice(0, imageExpandedDiv.style.left.length-2));
            let offsetY = e.clientY - parseInt(imageExpandedDiv.style.top.slice(0, imageExpandedDiv.style.top.length-2));

            // Перетаскивание
            let mousemoveListener = function(e) {
                let topAmount = e.clientY - offsetY;
                imageExpandedDiv.style.top = topAmount + 'px';
                let leftAmount = e.clientX - offsetX;
                imageExpandedDiv.style.left = leftAmount + 'px';
            };
            window.addEventListener('mousemove', mousemoveListener);

            // Отпускание картинки
            window.addEventListener('mouseup', function(e) {
                e.preventDefault();
                window.removeEventListener('mousemove', mousemoveListener);
                if (initialImageLeft == imageExpandedDiv.style.left &&
                    initialImageTop == imageExpandedDiv.style.top && e.button == 0) {
                    imageExpandedDiv.remove();
                }
            });
        };
        imageExpandedDiv.appendChild(imageExpandedLink);
        document.getElementsByTagName('body')[0].appendChild(imageExpandedDiv);
    }

    imagePreviewLink.onclick = imagePreviewClickListener;

    let imageDiv = document.createElement('div');
    let width = imagePreview.width ? imagePreview.width : 0;
    let height = imagePreview.height ? imagePreview.height : 0;
    if (width > MAX_PREVIEW_WIDTH) {
        let scale = width / MAX_PREVIEW_WIDTH;
        height = height / scale;
    }
    if (height > MAX_PREVIEW_HEIGHT) {
        height = MAX_PREVIEW_HEIGHT;
    }
    imageDiv.style.height = `${height + 1}px`;
    imageDiv.append(imagePreviewLink);
    return imageDiv;
}

async function createFileLinksDiv(files, hasSkippedFiles, postId, isPreview) {
    function createDownloadLink(name, text, blobLink) {
        let downloadLink = document.createElement('a');
        downloadLink.download = name;
        downloadLink.innerText = text;
        downloadLink.href = blobLink;
        return downloadLink;
    }
    function isImage(mime) {
        return !!mime && (mime.endsWith('/jpeg') ||
            mime.endsWith('/png') ||
            mime.endsWith('/webp'));
    }

    let fileLinksDiv = document.createElement('div');
    if (files.length == 0) {
        return fileLinksDiv;
    }

    let normalFilesCount = hasSkippedFiles > 0 ? files.length - 1 : files.length;
    for (let i = 0; i < normalFilesCount; i++) {
        let fileDiv = document.createElement('div');
		fileDiv.classList.add('post__file-attr');
        fileDiv.style = 'display: inline-block;';

        let filename = files[i].name;
        if (filename.length > MAX_FILENAME_LENGTH) {
            filename = filename.substring(0, MAX_FILENAME_LENGTH - 10) + '[...]' +
                filename.substring(filename.length - 5);
        }
        let blobLink = URL.createObjectURL(files[i].data);

        // Если тип поддерживается, создаем ссылку для открытия файла
        // в новой вкладке, иначе только ссылку для скачивания
        let mime = files[i].data.type;
        if (mime) {
            let link = document.createElement('a');
            link.target = "_blank";
            link.innerText = filename;
            link.href = blobLink;
            fileDiv.appendChild(link);
        }
        fileDiv.appendChild(document.createTextNode(' '));
        fileDiv.appendChild(createDownloadLink(files[i].name, `${mime ? '' : filename} \u2193`, blobLink));
        fileDiv.appendChild(document.createElement('br'));
        fileDiv.appendChild(document.createTextNode(`[${Utils.getHumanReadableSize(files[i].data.size)}]`));

        if (isPreview && isImage(mime)) {
            fileDiv.appendChild(document.createElement('br'));
            fileDiv.appendChild(await createImagePreview(blobLink));
        }
        fileLinksDiv.appendChild(fileDiv);

        if (i < normalFilesCount - 1) {
            fileLinksDiv.appendChild(document.createTextNode(', '));
        }
    }
    if (hasSkippedFiles > 0) {
        let allFilesLink = createDownloadLink(`all_files_${postId}.zip`, 'скачать все',
            URL.createObjectURL(files[files.length - 1].data));

        fileLinksDiv.insertAdjacentText('beforeend', ' (некоторые файлы пропущены)');
        if (isPreview) fileLinksDiv.insertAdjacentElement('afterbegin', document.createElement('br'));
        fileLinksDiv.insertAdjacentText('afterbegin', ` [${Utils.getHumanReadableSize(files[files.length - 1].data.size)}]): `);
        fileLinksDiv.insertAdjacentElement('afterbegin', allFilesLink);
        fileLinksDiv.insertAdjacentText('afterbegin', 'Файлы (');
    }
    else {
        //if (isPreview) fileLinksDiv.insertAdjacentElement('afterbegin', document.createElement('br'));
        //fileLinksDiv.insertAdjacentText('afterbegin', 'Файлы: ');
    }
    return fileLinksDiv;
}


module.exports.createHiddenPostImpl = createHiddenPostImpl
module.exports.loadPostFromImage = loadPostFromImage
module.exports.unzipPostData = unzipPostData
module.exports.createFileLinksDiv = createFileLinksDiv
module.exports.MESSAGE_MAX_LENGTH = MESSAGE_MAX_LENGTH