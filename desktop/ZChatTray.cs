// Z Chat desktop app - a WebView2 window around https://z-chat.men.
// Closing the window keeps Z Chat running in the background (calls keep
// ringing). There is NO tray icon: to bring the window back, launch "Z Chat"
// again from the Start menu / Windows search and the running instance is
// restored to the front.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

class ZChatApp : Form
{
    static Mutex mutex;
    static EventWaitHandle showEvent;
    WebView2 view;
    bool reallyQuit = false;

    [STAThread]
    static void Main()
    {
        bool created;
        mutex = new Mutex(true, "ZChatSingleInstanceMutex", out created);
        if (!created)
        {
            // Already running: ask the existing window to come back, then leave.
            try { EventWaitHandle.OpenExisting("ZChatShowEvent").Set(); }
            catch { }
            return;
        }
        showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "ZChatShowEvent");

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new ZChatApp());
    }

    public ZChatApp()
    {
        Text = "Z Chat";
        Width = 1280;
        Height = 860;
        MinimumSize = new Size(480, 400);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(30, 31, 34);

        string dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ZChat");
        Directory.CreateDirectory(dir);
        string icoPath = Path.Combine(dir, "zchat.ico");
        if (!File.Exists(icoPath))
        {
            try { IcoMaker.Write(icoPath); } catch { }
        }
        try { Icon = new Icon(icoPath); } catch { Icon = SystemIcons.Application; }

        EnsureStartMenuShortcut(Path.Combine(dir, "zchat.ico"));

        view = new WebView2();
        view.Dock = DockStyle.Fill;
        view.DefaultBackgroundColor = Color.FromArgb(30, 31, 34);
        Controls.Add(view);
        InitWebViewAsync(dir);

        FormClosing += OnClosing;

        // A second launch signals this event; bring ourselves back to the front.
        var watcher = new Thread(new ThreadStart(delegate
        {
            while (true)
            {
                showEvent.WaitOne();
                try { BeginInvoke(new Action(Restore)); } catch { }
            }
        }));
        watcher.IsBackground = true;
        watcher.Start();
    }

    async void InitWebViewAsync(string dir)
    {
        try
        {
            string udf = Path.Combine(dir, "WebView2");
            var env = await CoreWebView2Environment.CreateAsync(null, udf);
            await view.EnsureCoreWebView2Async(env);
            view.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            view.CoreWebView2.Settings.IsStatusBarEnabled = false;
            // Tag the embedded browser so the site can hide the "Download for Windows" button.
            string ua = view.CoreWebView2.Settings.UserAgent;
            if (!string.IsNullOrEmpty(ua) && ua.IndexOf("ZChatDesktop", StringComparison.OrdinalIgnoreCase) < 0)
            {
                view.CoreWebView2.Settings.UserAgent = ua + " ZChatDesktop/1.0";
            }
            view.CoreWebView2.Navigate("https://z-chat.men");
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Could not start the embedded browser.\r\n" +
                "Install the Microsoft Edge WebView2 Runtime and try again.\r\n\r\n" + ex.Message,
                "Z Chat", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    void OnClosing(object sender, FormClosingEventArgs e)
    {
        // Closing the window just hides it - Z Chat keeps running in the
        // background. Launch it again from the Start menu to bring it back.
        if (!reallyQuit && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            ShowInTaskbar = false;
        }
    }

    void Restore()
    {
        ShowInTaskbar = true;
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
        BringToFront();
    }

    void EnsureStartMenuShortcut(string icoPath)
    {
        try
        {
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            string exe = Application.ExecutablePath;
            string oldUrl = Path.Combine(programs, "Z Chat.url");
            if (File.Exists(oldUrl)) File.Delete(oldUrl);
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            dynamic shell = Activator.CreateInstance(shellType);
            dynamic lnk = shell.CreateShortcut(Path.Combine(programs, "Z Chat.lnk"));
            lnk.TargetPath = exe;
            lnk.WorkingDirectory = Path.GetDirectoryName(exe);
            lnk.IconLocation = (File.Exists(icoPath) ? icoPath : exe) + ",0";
            lnk.Description = "Z Chat - closing keeps it running; open from here to bring it back";
            lnk.Save();
        }
        catch { }
    }
}

static class IcoMaker
{
    public static void Write(string path)
    {
        using (var bmp = new Bitmap(64, 64))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (var bg = new SolidBrush(Color.FromArgb(88, 101, 242)))
                    g.FillEllipse(bg, 2, 2, 60, 60);
                using (var f = new Font("Segoe UI", 30, FontStyle.Bold))
                using (var tb = new SolidBrush(Color.White))
                {
                    var size = g.MeasureString("Z", f);
                    g.DrawString("Z", f, tb, (64 - size.Width) / 2, (64 - size.Height) / 2);
                }
            }
            byte[] png;
            using (var ms = new MemoryStream())
            {
                bmp.Save(ms, ImageFormat.Png);
                png = ms.ToArray();
            }
            using (var fs = new FileStream(path, FileMode.Create))
            using (var bw = new BinaryWriter(fs))
            {
                bw.Write((short)0); bw.Write((short)1); bw.Write((short)1);
                bw.Write((byte)64); bw.Write((byte)64);
                bw.Write((byte)0); bw.Write((byte)0);
                bw.Write((short)1); bw.Write((short)32);
                bw.Write(png.Length); bw.Write(22);
                bw.Write(png);
            }
        }
    }
}
