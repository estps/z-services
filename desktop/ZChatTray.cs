// Z Chat tray app - a WebView2 window around https://z-chat.men.
// Clicking X (or minimizing) hides it to the system tray so calls keep
// ringing in the background. Tray menu: Open / Quit. Single instance.
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
    NotifyIcon tray;
    WebView2 view;
    bool reallyQuit = false;

    [STAThread]
    static void Main()
    {
        bool created;
        mutex = new Mutex(true, "ZChatSingleInstanceMutex", out created);
        if (!created)
        {
            MessageBox.Show("Z Chat is already running (look in the system tray).", "Z Chat",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
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

        tray = new NotifyIcon();
        tray.Icon = Icon;
        tray.Text = "Z Chat - running in tray, calls will ring";
        tray.Visible = true;
        tray.ContextMenuStrip = BuildMenu();
        tray.DoubleClick += delegate { Restore(); };

        FormClosing += OnClosing;
        Resize += delegate
        {
            if (WindowState == FormWindowState.Minimized) HideToTray();
        };
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
        if (!reallyQuit && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            HideToTray();
        }
    }

    void HideToTray()
    {
        Hide();
        ShowInTaskbar = false;
        try
        {
            tray.ShowBalloonTip(2500, "Z Chat", "Still running in the tray - calls will keep ringing.",
                ToolTipIcon.Info);
        }
        catch { }
    }

    void Restore()
    {
        Show();
        ShowInTaskbar = true;
        WindowState = FormWindowState.Normal;
        Activate();
    }

    ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Z Chat", null, delegate { Restore(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, delegate
        {
            reallyQuit = true;
            tray.Visible = false;
            Application.Exit();
        });
        return menu;
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
            lnk.Description = "Z Chat - calls ring in the background";
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
