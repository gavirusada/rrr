# Gaviru Cam Studio — Official Android Mobile App Project 📱

මෙම Android Project එක මඟින් **Gaviru Cam Studio** සහ **VDO.Ninja 4K Live Broadcast** පද්ධතිය Android Mobile App එකක් (APK) ලෙස Compile කරගත හැක.

---

## 🌟 Features (විශේෂාංග):
1. **🥷 VDO.Ninja 4K Live Monitor:** කැමරාවේ 4K Ultra Quality Live Stream එක ලෝකයේ ඕනෑම තැනක සිට Phone එකෙන් බැලීම.
2. **📷 Camera Controls & Remote Focus:** Phone එකෙන් Camera ISO, Shutter, Aperture සහ Auto Focus ලයිට් වෙනස් කිරීම.
3. **📱 Phone Camera to OBS Studio:** ඔබේ Android දුරකථනයේ Camera එක OBS Studio එකට Wireless 60FPS WebCam එකක් ලෙස සම්බන්ධ කරගැනීම.
4. **⚡ Fullscreen & Keep Screen Awake:** Live Stream අතරතුර Screen එක Off වීම වැළැක්වීම.

---

## 🛠️ Build කරගන්නා ක්‍රම 3 (How to Build the APK):

### ක්‍රමය 1: Android Studio මඟින් (Easiest)
1. **Android Studio** විවෘත කරන්න.
2. `Open Project` ක්ලික් කර මෙම `GaviruCamStudio-Android` Folder එක තෝරන්න.
3. Gradle Sync අවසන් වූ පසු, Menu එකෙන් **Build ➔ Build Bundle(s) / APK(s) ➔ Build APK(s)** ක්ලික් කරන්න.
4. ඔබට `app-debug.apk` හෝ `GaviruCamStudio.apk` සූදානම්ව ලැබේ!

### ක්‍රමය 2: GitHub Actions මඟින් (Zero Setup — Cloud Free Build)
1. මෙම Repository එක GitHub වෙත Push කරන්න (හෝ Fork කරන්න).
2. GitHub Repository හි **Actions** tab එක වෙත යන්න.
3. **Build Gaviru Cam Studio Android APK** workflow එක ස්වයංක්‍රීයව run වී **Artifacts** තුළින් කෙලින්ම APK එක Download කරගත හැක.

### ක්‍රමය 3: 1-Click PWA App (කිසිදු Build කිරීමක් නැතිව Phone එකට Install කරගැනීම)
1. දුරකථනයේ Chrome බ්‍රවුසරයෙන් Gaviru Cam Studio Public URL එක (`https://xxxx.lhr.life/control`) හෝ Local IP එක විවෘත කරන්න.
2. **"📲 Install Mobile App"** බොත්තම ක්ලික් කරන්න.
3. එවිට ඔබේ දුරකථනයේ Icon එකක් සහිතව ස්වාධීන Native Mobile App එකක් ලෙස මෙය Install වේ!
