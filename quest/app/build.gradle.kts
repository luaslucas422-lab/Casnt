plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.calmchasm.casnt"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.calmchasm.casnt"
        minSdk = 29          // Quest 2 / 3 / 3S / Pro
        targetSdk = 34
        versionCode = 4
        versionName = "0.3.1"
    }

    // A fixed key is needed so updates install over the old app. CI passes it in from the
    // repo secrets (CASNT_KEYSTORE_B64 / CASNT_KEYSTORE_PASSWORD); without them the debug key is used.
    val ksFile = System.getenv("CASNT_KEYSTORE")?.let { file(it) }
    signingConfigs {
        if (ksFile != null && ksFile.exists()) {
            create("casnt") {
                storeFile = ksFile
                storePassword = System.getenv("CASNT_KEYSTORE_PASSWORD")
                keyAlias = "casnt"
                keyPassword = System.getenv("CASNT_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("casnt") ?: signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
