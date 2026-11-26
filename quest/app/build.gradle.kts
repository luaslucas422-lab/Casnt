plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.darkerdawnfr.casnt"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.darkerdawnfr.casnt"
        minSdk = 29          // Quest 2 / 3 / 3S / Pro
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        // Sideload builds are signed with the debug key unless a release keystore is provided.
        getByName("debug")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
