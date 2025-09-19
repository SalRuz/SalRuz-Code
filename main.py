# main.py

import logging
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
    # 🔁 ЗАМЕНИТЕ НА ВАШ ТОКЕН ОТ @BotFather
    import os
    TOKEN = os.getenv("7996632086:AAEzYgDiOEGMldWSJRkS8eOfzk_ECGdz074")

    application = Application.builder().token(TOKEN).build()

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("ping", ping))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_mention))
    application.add_error_handler(error_handler)

    logger.info("Бот запущен...")
    application.run_polling()

if __name__ == '__main__':
    keep_alive()
    main()
