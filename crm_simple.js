const express = require('express');
const bodyParser = require('body-parser');
const Firebird = require('node-firebird');
const Promise = require('bluebird');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(bodyParser.json());

/**
 * Получает конфигурацию хранения (storageLocation и storageCatalog) из таблицы PARAM в Firebird.
 * @param {Object} options - объект с параметрами подключения к Firebird (host, port, database, user, password, и т.п.)
 * @returns {Promise<Object>} - промис, который резолвится объектом вида { storageLocation, storageCatalog }
 */
/**
 * Функция для получения конфигурации хранения из Firebird.
 * Из таблицы PARAM извлекаются два параметра:
 *   - FILESTORAGELOCATION – целое число (1 – СУБД, 2 – Catalog)
 *   - FILESTORAGECATALOG – корневой каталог для хранения файлов (если режим = 2)
 */
function getStorageConfigFromFirebird(options) {
  return new Promise((resolve, reject) => {
    Firebird.attach(options, (err, db) => {
      if (err) {
        return reject(err);
      }
      const sql = "SELECT PARAM, VAL FROM PARAM WHERE UPPER(TRIM(PARAM)) IN ('FILESTORAGELOCATION','FILESTORAGECATALOG')";
      db.query(sql, (err, result) => {
        if (err) {
          db.detach();
          return reject(err);
        }
        // Значения по умолчанию:
        let config = { storageLocation: 1, storageCatalog: '' };
        result.forEach(row => {
          const key = String(row.PARAM).trim().toUpperCase();
          if (key === 'FILESTORAGELOCATION') {
            // Преобразуем в целое число; если преобразование не удалось – оставляем 1
            const val = parseInt(String(row.VAL).trim(), 10);
            config.storageLocation = isNaN(val) ? 1 : val;
          } else if (key === 'FILESTORAGECATALOG') {
            config.storageCatalog = String(row.VAL).trim();
          }
        });
        db.detach();
        resolve(config);
      });
    });
  });
}

app.post('/api/dbase/query', (req, res) => {

  const { type, token, sql, params, client__db_host, client__db_port, client__db_path } = req.body;
  const options = {
    host: client__db_host, // или ваш хост
    port: client__db_port,        // или ваш порт
    database: client__db_path, // путь к файлу базы данных
    user: 'SYSDBA',      // ваш пользователь
    password: 'masterkey', // ваш пароль
    lowercase_keys: true, // установите true, если требуется преобразование ключей в нижний регистр
    role: null,          // опционально
    pageSize: 4096,       // размер страницы для базы данных
    blobAsText: true
  };
  console.log(sql);
  Firebird.attach(options, function (err, db) {
    if (err) {
      return res.status(500).send({ error: 'Database connection failed' });
    }

    Promise.promisifyAll(db);

    db.queryAsync(sql, params || [])
      .then(result => {
        db.detach();
        if (result) { res.status(200).json(result) } else { res.status(200).json([]) }
      })
      .catch(error => {
        db.detach();
        res.status(500).json({ error: 'Query execution failed', details: error.message });
      });
  });
});

// Новый эндпоинт для генерации PDF
app.post('/api/generate-pdf', (req, res) => {
  const { token, client__db_host, client__db_port, client__db_path, reportName, id } = req.body;

  // Путь к базе данных
  const dbPath = client__db_host + '/' + client__db_port + ':' + client__db_path;
  // Валидация входных параметров
  if (!dbPath || !reportName || !id) {
    return res.status(400).json({ error: 'Missing parameters: dbPath, reportName, id are required.' });
  }

  // Путь к Delphi-программе
  const delphiExePath = path.join(__dirname, 'genpdf.exe'); // Убедитесь, что genpdf.exe находится в той же директории

  // Проверка существования Delphi-программы
  const fs = require('fs');
  if (!fs.existsSync(delphiExePath)) {
    return res.status(500).json({ error: 'PDF generator not found on server.' });
  }

  // Запуск Delphi-программы с параметрами
  const delphiProcess = spawn(delphiExePath, [dbPath, reportName, id]);

  let stdoutData = '';
  let stderrData = '';

  // Захват данных из stdout
  delphiProcess.stdout.on('data', (data) => {
    stdoutData += data.toString();
  });

  // Захват данных из stderr
  delphiProcess.stderr.on('data', (data) => {
    stderrData += data.toString();
  });

  // Обработка завершения процесса
  delphiProcess.on('close', (code) => {
    if (code !== 0) {
      console.error(`Delphi process exited with code ${code}`);
      console.error(`Stderr: ${stderrData}`);
      return res.status(500).json({ error: 'Error generating PDF.', details: stderrData });
    }

    if (!stdoutData) {
      console.error('No data received from Delphi process.');
      return res.status(500).json({ error: 'No data received from PDF generator.' });
    }

    // Предполагается, что stdoutData содержит Base64 строку PDF
    let pdfBase64 = stdoutData.trim();

    // уберем символы переноса строки
    pdfBase64 = pdfBase64.replace(/[\r\n]/g, '');
    // уберем символы переноса строки windows
    pdfBase64 = pdfBase64.replace(/\r/g, '');

    // Опционально: можно добавить проверку корректности Base64 строки
    if (!/^[a-zA-Z0-9/+=]+$/.test(pdfBase64)) {
      console.error('Invalid Base64 string received from Delphi process.');
      return res.status(500).json({ error: 'Invalid Base64 string received from PDF generator.' });
    }

    res.status(200).json({ pdf: pdfBase64 });
  });

  // Обработка ошибок запуска процесса
  delphiProcess.on('error', (err) => {
    console.error('Failed to start Delphi process:', err);
    res.status(500).json({ error: 'Failed to start PDF generator.', details: err.message });
  });
});

/**
 * Endpoint для получения файла.
 *
 * Ожидается, что в теле запроса передаются:
 *   - token
 *   - fileId — идентификатор файла (из таблицы FILES)
 *   - client__db_host, client__db_port, client__db_path — параметры подключения к Firebird
 *
 * В каталожном режиме (storageLocation === 2) остальные данные извлекаются из таблицы FILES:
 *   CUSTNO и FILE_NAME используются для формирования пути к физическому файлу:
 *
 *     {storageCatalog}/FILES/{CUSTNO}/{fileId}_{FILE_NAME}
 *
 * Если storageLocation === 1, файл извлекается из БЛОБа (FILE_BODY).
 */
app.post('/api/dbase/get-file', async (req, res) => {
  const { token, fileId, client__db_host, client__db_port, client__db_path } = req.body;

  // Параметры подключения к Firebird (используем их и для получения конфигурации, и для извлечения файла)
  const fbOptions = {
    host: client__db_host,
    port: client__db_port,
    database: client__db_path,
    user: 'SYSDBA',
    password: 'masterkey',
    lowercase_keys: true,
    role: null,
    pageSize: 4096,
    blobAsText: false
  };

  let storageConfig;
  try {
    storageConfig = await getStorageConfigFromFirebird(fbOptions);
  } catch (err) {
    console.error("Ошибка получения конфигурации хранения из Firebird:", err);
    return res.status(500).json({ error: 'Error retrieving storage config', details: err.message });
  }

  const { storageLocation, storageCatalog } = storageConfig;
  console.log("Полученная конфигурация хранения:", storageConfig);

  if (storageLocation === 2) {
    // Режим "catalog": извлекаем данные о файле (FILE_NAME, CUSTNO) из таблицы FILES
    Firebird.attach(fbOptions, (err, db) => {
      if (err) {
        console.error("Ошибка подключения к базе:", err);
        return res.status(500).json({ error: 'Database connection failed', details: err.message });
      }
      const sql = "SELECT FILE_NAME, CUSTNO FROM FILES WHERE ID = ?";
      db.query(sql, [fileId], (err, result) => {
        if (err) {
          db.detach();
          console.error("Ошибка выполнения запроса:", err);
          return res.status(500).json({ error: 'Query execution failed', details: err.message });
        }
        if (!result || result.length === 0) {
          db.detach();
          return res.status(404).json({ error: 'File not found in database' });
        }
        const fileRecord = result[0];
        const dbFileName = fileRecord.file_name;
        const custNo = fileRecord.custno;
        db.detach();

        // Формируем путь к файлу:
        // {storageCatalog}/FILES/{custNo}/{fileId}_{dbFileName}
        const sourcePath = path.join(
          storageCatalog,
          "FILES",
          String(custNo),
          `${fileId}_${dbFileName}`
        );
        console.log(`Catalog mode: копирование файла из ${sourcePath}`);
        fs.access(sourcePath, fs.constants.R_OK, (err) => {
          if (err) {
            console.error("Файл не найден в каталоге:", err);
            return res.status(404).json({ error: 'File not found in catalog', details: err.message });
          }
          res.setHeader('Content-Disposition', `attachment; filename="${dbFileName}"`);
          res.setHeader('Content-Type', 'application/octet-stream');
          const readStream = fs.createReadStream(sourcePath);
          readStream.on('error', (streamErr) => {
            console.error("Ошибка чтения файла из каталога:", streamErr);
            res.status(500).json({ error: 'Error reading file from catalog', details: streamErr.message });
          });
          readStream.pipe(res);
        });
      });
    });
  } else {
    // Режим "database": извлекаем файл из Firebird (BLOB)
    console.log(`Database mode: Получаем файл с ID=${fileId} из базы ${client__db_path}`);
    Firebird.attach(fbOptions, (err, db) => {
      if (err) {
        console.error("Ошибка подключения к базе:", err);
        return res.status(500).json({ error: 'Database connection failed', details: err.message });
      }
      const sql = "SELECT FILE_NAME, FILE_BODY FROM FILES WHERE ID = ?";
      db.query(sql, [fileId], (err, result) => {
        if (err) {
          db.detach();
          console.error("Ошибка выполнения запроса:", err);
          return res.status(500).json({ error: 'Query execution failed', details: err.message });
        }
        if (!result || result.length === 0) {
          db.detach();
          return res.status(404).json({ error: 'File not found in database' });
        }

        const fileRecord = result[0];
        const dbFileName = fileRecord.file_name;
        const fileBody = fileRecord.file_body;

        if (typeof fileBody === 'function') {
          fileBody((blobErr, blobName, blobStream) => {
            if (blobErr) {
              db.detach();
              console.error("Ошибка чтения BLOB:", blobErr);
              return res.status(500).json({ error: 'Error reading BLOB', details: blobErr.message });
            }
            let chunks = [];
            blobStream.on('data', (chunk) => { chunks.push(chunk); });
            blobStream.on('end', () => {
              const blobData = Buffer.concat(chunks);
              db.detach();
              res.setHeader('Content-Disposition', `attachment; filename="${dbFileName}"`);
              res.setHeader('Content-Type', 'application/octet-stream');
              res.send(blobData);
            });
            blobStream.on('error', (streamErr) => {
              db.detach();
              console.error("Ошибка в потоке BLOB:", streamErr);
              return res.status(500).json({ error: 'Error in BLOB stream', details: streamErr.message });
            });
          });
        } else {
          db.detach();
          res.setHeader('Content-Disposition', `attachment; filename="${dbFileName}"`);
          res.setHeader('Content-Type', 'application/octet-stream');
          res.send(fileBody);
        }
      });
    });
  }
});

app.get('/test', (req, res) => {
  res.status(200).send('OK');
});

const PORT = 3061;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
