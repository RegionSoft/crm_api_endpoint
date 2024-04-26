const express = require('express');
const bodyParser = require('body-parser');
const Firebird = require('node-firebird');
const Promise = require('bluebird');

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
    Firebird.attach(options, function(err, db) {
        if (err) {
            return res.status(500).send({ error: 'Database connection failed' });
        }

        Promise.promisifyAll(db);

        db.queryAsync(sql, params || [])
            .then(result => {
                db.detach();
                if (result) {res.status(200).json(result)} else {res.status(200).json([])}
            })
            .catch(error => {
                db.detach();
                res.status(500).json({ error: 'Query execution failed', details: error.message });
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
