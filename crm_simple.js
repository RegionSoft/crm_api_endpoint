const express = require('express');
const bodyParser = require('body-parser');
const Firebird = require('node-firebird');
const Promise = require('bluebird');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(bodyParser.json());

// Константы для подключения к базе данных

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

app.post('/api/dbase/get-file', (req, res) => {
    const { token, fileId, client__db_host, client__db_port, client__db_path } = req.body;

    // Параметр blobAsText устанавливаем в false, чтобы получать бинарные данные.
    const options = {
        host: client__db_host,
        port: client__db_port,
        database: client__db_path,
        user: 'SYSDBA',
        password: 'masterkey',
        lowercase_keys: true,  // поля будут возвращаться в нижнем регистре: file_name, file_body
        role: null,
        pageSize: 4096,
        blobAsText: false
    };

    console.log(`Получаем файл с ID=${fileId} из базы ${client__db_path}`);
    Firebird.attach(options, (err, db) => {
        if (err) {
            console.error("Ошибка подключения к базе:", err);
            return res.status(500).json({ error: 'Database connection failed', details: err.message });
        }

        // Запрос выбирает только FILE_NAME и FILE_BODY
        const sql = "SELECT FILE_NAME, FILE_BODY FROM FILES WHERE ID = ?";
        db.query(sql, [fileId], (err, result) => {
            if (err) {
                db.detach();
                console.error("Ошибка выполнения запроса:", err);
                return res.status(500).json({ error: 'Query execution failed', details: err.message });
            }
            if (!result || result.length === 0) {
                db.detach();
                return res.status(404).json({ error: 'File not found' });
            }

            const fileRecord = result[0];
            // При использовании lowercase_keys получаем имена столбцов в нижнем регистре
            const fileName = fileRecord.file_name;
            const fileData = fileRecord.file_body; // FILE_BODY – BLOB с бинарными данными

            db.detach();
            // Устанавливаем заголовки для отдачи файла
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            res.setHeader('Content-Type', 'application/octet-stream');
            // Отдаем бинарные данные файла
            res.send(fileData);
        });
    });
});

app.get('/test', (req, res) => {
    res.status(200).send('OK');
});

const PORT = 3061;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
