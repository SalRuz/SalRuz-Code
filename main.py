# main.py

import logging
import os
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from keep_alive import keep_alive

# Включаем логирование
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# 🔁 ЗАМЕНИТЕ НА РЕАЛЬНЫЙ ЮЗЕРНЕЙМ ВАШЕГО БОТА (без @)
BOT_USERNAME = "SalRuz_bot"

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text('Привет! Можешь упомянуть меня в чате — я отвечу!')

async def handle_mention(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.message
    text = message.text or ""

    if f"@{BOT_USERNAME}" in text:
        await message.reply_text("Привет!")

async def ping(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text("Я живой и работаю! 🤖")

async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    logger.error(msg="Exception while handling an update:", exc_info=context.error)

def main() -> None:
    # Получаем токен из переменной окружения
    TOKEN = os.getenv("BOT_TOKEN")

    # 🔍 ОТЛАДКА: Печатаем токен (в логах Render вы увидите его значение)
    print(f"DEBUG: TOKEN = '{TOKEN}'")

    # Проверка: если токен пустой или None — выводим ошибку и выходим
    if not TOKEN or TOKEN.strip() == "":
        print("❌ ОШИБКА: Токен не найден! Проверьте переменную окружения BOT_TOKEN в Render.")
        print("ℹ️  Убедитесь, что:")
        print("   - Переменная называется точно: BOT_TOKEN")
        print("   - Значение не пустое и скопировано правильно из @BotFather")
        print("   - Вы нажали 'Save, rebuild and deploy' после добавления токена")
        return  # Завершаем выполнение, чтобы избежать InvalidToken

    # Создаём приложение бота
    application = Application.builder().token(TOKEN).build()

    # Добавляем обработчики
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("ping", ping))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_mention))
    application.add_error_handler(error_handler)

    logger.info("Бот запущен...")
    application.run_polling()

if __name__ == '__main__':
    keep_alive()  # Запускаем Flask-сервер, чтобы Render не засыпал
    main()
