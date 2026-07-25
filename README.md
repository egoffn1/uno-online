# UNO Online

Многопользовательская онлайн-игра UNO с real-time синхронизацией.

## Локальный запуск

```bash
git clone https://github.com/egoffn1/uno-online.git
cd uno-online
npm install
npm start
```

Открой `http://localhost:3000`

## Деплой на Render (бесплатно)

1. Зайди на https://render.com и залогинься (GitHub)
2. Нажми **New +** → **Web Service**
3. Подключи репозиторий `egoffn1/uno-online`
4. Настройки:
   - **Name**: `uno-online` (или любое)
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: **Free**
5. Нажми **Create Web Service**

Через пару минут игра будет доступна по ссылке `https://uno-online.onrender.com`

## Особенности

- Создание комнаты по коду
- Приглашение по ссылке (`?room=XXXXX`)
- Автоматический хостинг на Render (спит без активности, просыпается при заходе)
- ПК + мобила (адаптивный дизайн)
- Все карты UNO: цифры, skip, reverse, +2, wild, wild +4
