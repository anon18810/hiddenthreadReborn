# Стеганографический скрипт
## Что это?
Скрипт позволяет запаковать текст и/или файлы в картинку-контейнер, затем запостить эту картинку. Другие пользователи скрипта увидят ваше сообщение, спрятанное в картинке-контейнере. Ваше сообщение может быть адресовано конкретному анону, тогда для других ваше сообщение не будет видно - они увидят только картинку-контейнер.

Больше никаких автозамен, вордфильтров, правил, где модератор может забанить любого неугодного. Всё тут ограничивается лишь вашей фантазией.

## Как установить?
Установите любое из расширений:
* [Violentmonkey](https://violentmonkey.github.io)
* [Tampermonkey](https://www.tampermonkey.net)

Установите скрипт:
* Зайти [сюда](./HiddenThread.user.js) и нажать на `Raw` справа. Кликните на `установить`.
* Откройте любой тред, обновите страницу.
* В треде под обычной формой постинга (не плавающей) появится вторая форма, через которую можно загрузить скрытопосты.

## Как пользоваться?
Для отправки скрытопоста нужно сделать следующие вещи:
1. Написать скрытый текст под обычной формой постинга (не плавающей).
2. *Опционально.* Выбрать картинку-контейнер, которая будет контейнером для твоего скрытого поста, пользователям без скрипта в треде будет видна лишь картинка-контейнер. Если картинка не выбрана, то она будет создана автоматически.
3. *Опционально.* Выбрать скрытые файлы. Скрытый файл может быть чем угодно, вебм, картинкой т.п.
4. *Опционально.* Подписать пост, сгенерировав и сохранив куда-нибудь свой приватный ключ, чтобы не потерять его при обновлении страницы. Тогда тебе смогут писать в местную личку другие анончики. Чтобы написать какому-то анону лично, нужно лишь вставить его ключ, который отображается над его скрытым постом, в графу `Публичный ключ получателя`.
5. Нажать на большую кнопку снизу `Создать картинку со скрытопостом`. Картинка сгенерируется и сама вставится в форму постинга. Остаётся только отправить её.

## FAQ
### Как это выглядит?
![](https://i.imgur.com/I3MfqSr.png)

### Зачем нужен пароль?
Пароль создан для тех, кто хочет запилить скрытотред только для своих, для тех кто знает пароль. Либо на случай, когда треды с пустым паролем будут затирать или банить.

### Что такое ключи?
Нажимая на кнопку `Сгенерировать ключи` у вас появляются два ключа.
* `Публичный ключ` - этот ключ доступен всем кто видит ваш пост. Он используется для того чтобы зашифровать сообщение и отравить его вам. Публичный ключ генерируется из приватного, его можно не сохранять.
* `Приватный ключ` - этот ключ должен быть доступен только вам. С помощью него можно расшифровать сообщение, которое было зашифровано публичным ключом. Кроме того, ключ можно использовать как уникальное имя - никто не сможет подписаться вашим публичным ключом, не зная приватного.

Чтобы отобразились личные сообщения введите свой приватный ключ в поле `Приватный ключ` и нажмите `Загрузить скрытопосты`.

### Как это работает?
Для скрытия данных используется стеганография методом LSB в PNG-изображениях.
- Шифрование произвольным паролем (`AES256-CBC`).
- Цифровая подпись поста приватным ключом (`ECDSA` `P-256`).
- Отправка приватных сообщений, которые сможет расшифровать только получатель (`ECDH` `P-256`).

### Известные ошибки
* В браузере `LibreWolf` ошибка `Blocked https://2ch.hk/.../res/...html from extracting canvas data because no user input was detected.` Для исправления зайдите в `about:config` и измените параметр `privacy.resistFingerprinting.autoDeclineNoUserInputCanvasPrompts` на `false`.

### История версий
- [0.4](../../pull/7)
- [0.3](../../pull/5)
- [0.2](../../pull/4)
