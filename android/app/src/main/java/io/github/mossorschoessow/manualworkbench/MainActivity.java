package io.github.mossorschoessow.manualworkbench;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.LabeledIntent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.Parcelable;
import android.text.InputType;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 把倉庫根目錄的網頁應用（打包在 assets/www）放進 WebView 運行。
 *
 * 文件通過虛擬的 https://appassets.androidplatform.net/ 提供，這樣網頁處於安全上下文，
 * IndexedDB 等功能和瀏覽器裡一樣可用；手冊資料存在本應用的私有存儲裡，只有卸載才會清除。
 * WebView 做不到的幾件事（保存文件、分享、掃碼）由下面的 NativeApp 橋接完成，見 app.js 的 nativeFile()。
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";
    private static final int REQ_PICK = 1;
    private static final int REQ_SAVE = 2;

    private WebView web;
    private ValueCallback<Uri[]> pickCallback;
    private File pendingSaveFile;
    private String pendingSaveCb;
    private String pendingScanCb;
    private final Map<String, OutputStream> writing = new ConcurrentHashMap<>();
    private final Map<String, File> written = new ConcurrentHashMap<>();
    private final Map<String, String> writtenMime = new ConcurrentHashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        deleteRecursive(outDir()); // 上次分享 / 保存留下的臨時文件

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        web = new WebView(this);
        web.setLayoutParams(new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100); // 版面按 100% 字號設計和測試
        s.setMediaPlaybackRequiresUserGesture(false);

        web.setWebViewClient(new LocalClient());
        web.setWebChromeClient(new Chrome());
        web.addJavascriptInterface(new Bridge(), "NativeApp");
        web.loadUrl(START_URL);
    }

    @Override
    public void onBackPressed() {
        // 網頁用 history.pushState 管理彈出層和閱讀器，返回鍵先關掉它們
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /* ---------------- 本機文件服務 ---------------- */

    private class LocalClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!HOST.equals(u.getHost())) return null;
            String path = u.getPath();
            if (path == null || path.equals("/")) path = "/index.html";
            if (path.contains("..")) return notFound();
            String mime = mimeOf(path);
            try {
                InputStream in = getAssets().open("www" + path);
                boolean text = mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json") || mime.contains("svg");
                return new WebResourceResponse(mime, text ? "utf-8" : null, in);
            } catch (IOException e) {
                return notFound();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (HOST.equals(u.getHost())) return false;
            try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { }
            return true;
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                Collections.<String, String>emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    /* ---------------- 選文件、對話框 ---------------- */

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (pickCallback != null) pickCallback.onReceiveValue(null);
            pickCallback = callback;
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            String[] mimes = acceptMimes(params.getAcceptTypes());
            if (mimes != null) i.putExtra(Intent.EXTRA_MIME_TYPES, mimes);
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(i, REQ_PICK);
            } catch (ActivityNotFoundException e) {
                pickCallback = null;
                return false;
            }
            return true;
        }

        // 不用系統默認對話框：它的標題會顯示網址
        @Override
        public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
            new AlertDialog.Builder(MainActivity.this).setMessage(message)
                    .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                    .setOnCancelListener(d -> result.confirm()).show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
            new AlertDialog.Builder(MainActivity.this).setMessage(message)
                    .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                    .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel()).show();
            return true;
        }

        @Override
        public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, final JsPromptResult result) {
            final EditText input = new EditText(MainActivity.this);
            input.setSingleLine(true);
            if (defaultValue != null) { input.setText(defaultValue); input.selectAll(); }
            if (defaultValue != null && defaultValue.matches("\\d+")) input.setInputType(InputType.TYPE_CLASS_NUMBER);
            FrameLayout box = new FrameLayout(MainActivity.this);
            int pad = (int) (20 * getResources().getDisplayMetrics().density);
            box.setPadding(pad, pad / 2, pad, 0);
            box.addView(input);
            new AlertDialog.Builder(MainActivity.this).setMessage(message).setView(box)
                    .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm(input.getText().toString()))
                    .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel()).show();
            input.requestFocus();
            return true;
        }
    }

    /** accept=".manlib" 這類系統不認識的擴展名就不過濾，讓用戶自己選。 */
    private static String[] acceptMimes(String[] accept) {
        if (accept == null) return null;
        List<String> out = new ArrayList<>();
        for (String raw : accept) {
            for (String a : raw.split(",")) {
                a = a.trim().toLowerCase(Locale.ROOT);
                if (a.isEmpty()) continue;
                if (a.contains("/")) { out.add(a); continue; }
                String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(a.replaceFirst("^\\.", ""));
                if (m == null) return null;
                out.add(m);
            }
        }
        return out.isEmpty() ? null : out.toArray(new String[0]);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK) {
            if (pickCallback == null) return;
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null && clip.getItemCount() > 0) {
                    result = new Uri[clip.getItemCount()];
                    for (int i = 0; i < result.length; i++) result[i] = clip.getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            pickCallback.onReceiveValue(result);
            pickCallback = null;
            return;
        }
        if (requestCode == REQ_SAVE) {
            final File src = pendingSaveFile;
            final String cb = pendingSaveCb;
            pendingSaveFile = null;
            pendingSaveCb = null;
            if (src == null) return;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                deleteRecursive(src.getParentFile());
                resolve(cb, "cancel");
                return;
            }
            final Uri dest = data.getData();
            new Thread(() -> {
                String r = "ok";
                try (InputStream in = new FileInputStream(src);
                     OutputStream out = getContentResolver().openOutputStream(dest, "w")) {
                    if (out == null) throw new IOException("cannot open destination");
                    byte[] buf = new byte[256 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                } catch (Exception e) {
                    r = "error:" + e.getMessage();
                }
                deleteRecursive(src.getParentFile());
                resolve(cb, r);
            }).start();
            return;
        }
        IntentResult scan = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (scan != null) {
            String cb = pendingScanCb;
            pendingScanCb = null;
            resolve(cb, scan.getContents() == null ? "" : scan.getContents());
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /* ---------------- 給 app.js 調用的橋接 ---------------- */

    private class Bridge {
        /** 開始接收一個文件，返回 id；出錯返回 "error:…" */
        @JavascriptInterface
        public String begin(String name, String mime) {
            try {
                String id = UUID.randomUUID().toString();
                File dir = new File(outDir(), id);
                if (!dir.mkdirs()) throw new IOException("cannot create " + dir);
                File f = new File(dir, safeName(name));
                writing.put(id, new FileOutputStream(f));
                written.put(id, f);
                writtenMime.put(id, mime == null ? "" : mime);
                return id;
            } catch (Exception e) {
                return "error:" + e.getMessage();
            }
        }

        /** 追加一塊 base64 數據；成功返回空字串 */
        @JavascriptInterface
        public String chunk(String id, String b64) {
            OutputStream out = writing.get(id);
            if (out == null) return "unknown file";
            try {
                out.write(Base64.decode(b64, Base64.DEFAULT));
                return "";
            } catch (Exception e) {
                return String.valueOf(e.getMessage());
            }
        }

        /** action = save（讓用戶選保存位置）或 share（用其他應用打開 / 分享）；結果通過 cb 回傳 */
        @JavascriptInterface
        public void finish(final String id, final String action, final String cb) {
            OutputStream out = writing.remove(id);
            final File f = written.remove(id);
            final String mime = mimeFor(f, writtenMime.remove(id));
            try {
                if (out != null) out.close();
            } catch (IOException e) {
                resolve(cb, "error:" + e.getMessage());
                return;
            }
            if (f == null) { resolve(cb, "error:unknown file"); return; }
            runOnUiThread(() -> {
                if ("save".equals(action)) startSave(f, mime, cb);
                else { share(f, mime); resolve(cb, "ok"); }
            });
        }

        @JavascriptInterface
        public void scan(final String prompt, final String cb) {
            runOnUiThread(() -> {
                if (pendingScanCb != null) resolve(pendingScanCb, "");
                pendingScanCb = cb;
                IntentIntegrator it = new IntentIntegrator(MainActivity.this);
                it.setPrompt(prompt == null ? "" : prompt);
                it.setOrientationLocked(false);
                it.setBeepEnabled(false);
                it.initiateScan();
            });
        }
    }

    private void startSave(File f, String mime, String cb) {
        if (pendingSaveCb != null) resolve(pendingSaveCb, "cancel");
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(mime);
        i.putExtra(Intent.EXTRA_TITLE, f.getName());
        pendingSaveFile = f;
        pendingSaveCb = cb;
        try {
            startActivityForResult(i, REQ_SAVE);
        } catch (ActivityNotFoundException e) {
            pendingSaveFile = null;
            pendingSaveCb = null;
            resolve(cb, "error:" + e.getMessage());
        }
    }

    /** 系統分享面板，並把「用 WPS 等應用打開」的候選放在最前面 */
    private void share(File f, String mime) {
        Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".files", f);
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(mime);
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.setClipData(ClipData.newRawUri(f.getName(), uri));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

        Intent view = new Intent(Intent.ACTION_VIEW);
        view.setDataAndType(uri, mime);
        view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        PackageManager pm = getPackageManager();
        List<LabeledIntent> openers = new ArrayList<>();
        for (ResolveInfo ri : pm.queryIntentActivities(view, 0)) {
            if (getPackageName().equals(ri.activityInfo.packageName)) continue;
            Intent target = new Intent(view);
            target.setComponent(new ComponentName(ri.activityInfo.packageName, ri.activityInfo.name));
            openers.add(new LabeledIntent(target, ri.activityInfo.packageName, ri.loadLabel(pm), ri.getIconResource()));
        }
        Intent chooser = Intent.createChooser(send, getString(R.string.share_title));
        if (!openers.isEmpty()) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, openers.toArray(new Parcelable[0]));
        try {
            startActivity(chooser);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_app, Toast.LENGTH_LONG).show();
        }
    }

    private void resolve(final String cb, final String value) {
        if (cb == null) return;
        final String js = "window.__nativeResolve && window.__nativeResolve(" + JSONObject.quote(cb) + "," + JSONObject.quote(value) + ")";
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(js, null); });
    }

    /* ---------------- 工具 ---------------- */

    private File outDir() {
        return new File(getCacheDir(), "out"); // 與 res/xml/file_paths.xml 對應
    }

    private static String safeName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        if (n.isEmpty() || n.equals(".") || n.equals("..")) n = "file";
        return n.length() > 120 ? n.substring(n.length() - 120) : n;
    }

    private static String mimeFor(File f, String given) {
        if (given != null && !given.isEmpty() && !given.equals("application/octet-stream")) return given;
        if (f != null) {
            String name = f.getName();
            int dot = name.lastIndexOf('.');
            if (dot >= 0) {
                String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
                if (m != null) return m;
            }
        }
        return "application/octet-stream";
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursive(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
