const Applet = imports.ui.applet;
const Util = imports.misc.util;
const Settings = imports.ui.settings;

const Gio = imports.gi.Gio;
const Soup = imports.gi.Soup;
const Cinnamon = imports.gi.Cinnamon;
//const Tweener = imports.ui.tweener; // To be deleted
const Lang = imports.lang;
const Mainloop = imports.mainloop;

const PopupMenu = imports.ui.popupMenu;
const St = imports.gi.St;
const Flashspot = imports.ui.flashspot;
const GLib = imports.gi.GLib;

let session = new Soup.SessionAsync();
Soup.Session.prototype.add_feature.call(session, new Soup.ProxyResolverDefault());

const BING = "bing"
const UNSPLASH = "unsplash"
const DAY = "day"
const HOUR = "hour"
const MINUTE = "minute"

function MyApplet(metadata, orientation, panel_height, instance_id) {
    this._init(metadata, orientation, panel_height, instance_id);
}

MyApplet.prototype = {
    __proto__: Applet.IconApplet.prototype,

    _init: function(metadata, orientation, panel_height, instance_id) {
        Applet.IconApplet.prototype._init.call(this, orientation, panel_height, instance_id);

        this.set_applet_icon_name("wallpaper");
        // this.set_applet_tooltip(_("Force wallpaper update"));

        this.force_update_menu_item = new PopupMenu.PopupIconMenuItem(_("Force wallpaper update"),
                "go-jump",
                St.IconType.SYMBOLIC);
        this.force_update_menu_item.connect('activate', Lang.bind(this, this._update));
        this._applet_context_menu.addMenuItem(this.force_update_menu_item);

        this.go_to_menu_item = new PopupMenu.PopupIconMenuItem(_("Go to wallpaper page"),
                "edit-find",
                St.IconType.SYMBOLIC);
        this.go_to_menu_item.connect('activate', Lang.bind(this, this.go_to_page));
        this._applet_context_menu.addMenuItem(this.go_to_menu_item);


        this.metadata = metadata
        let dir_path = this.metadata["directory"];
        this.save_path = dir_path.replace('~', GLib.get_home_dir());
        let saveFolder = Gio.file_new_for_path(this.save_path);
        if (!saveFolder.query_exists(null)) {
            saveFolder.make_directory_with_parents(null);
        }

        this.settings = new Settings.AppletSettings(this, "daily-wallpaper@mmewen", instance_id);
        this.settings.bindProperty(Settings.BindingDirection.IN,
           "source", "source", this.on_settings_changed, null);
        this.settings.bindProperty(Settings.BindingDirection.IN,
           "locale", "locale", this.on_settings_changed, null);
        this.settings.bindProperty(Settings.BindingDirection.IN,
           "unsplashKey", "unsplashKey", this.on_settings_changed, null);
        this.settings.bindProperty(Settings.BindingDirection.IN,
           "period", "period", this.on_period_setting_changed, null);

        // Consts
        this._makeConstants();

        this._update();
    },

    _makeConstants: function(){
        this.bingJsonUrl = "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=";
        this.unsplashUrlTokenParam = "client_id=" + this.unsplashKey;
        this.unsplashUtmParam = "utm_source=daily-wallpaper&utm_medium=referral";
        this.unsplashJsonUrl = "https://api.unsplash.com/photos/random?orientation=landscape&" + this.unsplashUrlTokenParam;
    },

    _update: function(){
        try {
            this.refresh();
        }
        catch (e) {
            global.logError(e);
        }
    },

    refresh: function() {
        if (this.updateInProgress) return true;
        if (this.source == "disable") return true;
        this.updateInProgress = true;
        
        let url, filename;

        if (this._timeoutId) {
            Mainloop.source_remove(this._timeoutId);
        }

        if (this.source === BING) {
            url = this.bingJsonUrl + this.locale;
            filename = this.save_path+'/bingJsonUrl.json';
            let jsonFile = Gio.file_new_for_path(filename);
            this.download_file(url, filename, Lang.bind(this, this.on_bing_json_downloaded));
        }
        else if (this.source === UNSPLASH) {
            if(this.unsplashKey === "")
            {
                this.set_applet_tooltip(_("Unspash API key unset, see parameters"));
                global.logError("Unspash API key unset, please set it in parameters");
                this.updateInProgress = false;
                return false;
            }

            url = this.unsplashJsonUrl;
            filename = this.save_path+'/unsplashJsonUrl.json';
            let jsonFile = Gio.file_new_for_path(filename);
            this.download_file(url, filename, Lang.bind(this, this.on_unsplash_json_downloaded));
        }
        
        return true;
    },

    download_file: function(url, localFilename, callback) {
        let outFile = Gio.file_new_for_path(localFilename);
        var outStream = new Gio.DataOutputStream({
            base_stream:outFile.replace(null, false, Gio.FileCreateFlags.NONE, null)});

        var message = Soup.Message.new('GET', url);
        session.queue_message(message, function(session, response) {
            if (response.status_code !== Soup.KnownStatusCode.OK) {
                global.log("Error during download: response code " + response.status_code
                    + ": " + response.reason_phrase + " - " + response.response_body.data);
                callback(false, null);
                return true;
            }

            try {
                Cinnamon.write_soup_message_to_stream(outStream, message);
                outStream.close(null);
            }
            catch (e) {
                global.logError("Site seems to be down. Error was:");
                global.logError(e);

                callback(false, null);
                return true;
            }

            callback(true, localFilename);
            return false;
         });
    },

    on_bing_json_downloaded: function(success, filename, cached) {
        if (success) {
            global.log("Bing JSON successfully downloaded");
            let bingJson = JSON.parse(Cinnamon.get_file_contents_utf8_sync(filename));

            // If JSON isn't correct, return
            if (bingJson["images"] === undefined || bingJson["images"].length == 0) {
                global.logError("Bing JSON doesn't have the expected structure");
                this.updateInProgress = false;
                this.retry_soon();
                return true;
            }

            let imageInfo = bingJson.images[0];

            // If wallpaper is not available for download, cancel
            if (!imageInfo.wp)
            {
                global.logError(bingJson.tooltips.walle);
                this.updateInProgress = false;
                return true;
            }

            let wallpaperNameParts = imageInfo.url.split("/");
            let wallpaperNameWithExt = wallpaperNameParts[wallpaperNameParts.length - 1];
            let wallpaperName = wallpaperNameWithExt.split(".")[0];


            // If the wallpaper hasn't changed, simply don't download it
            if (this._currentWallpaper == wallpaperName) {
                global.log("Already have that wallpaper, won\'t download it again.");
                this.updateInProgress = false;
                return true;
            }

            this.futureWallpaper = wallpaperName;
            this.futureWallpaperPage = imageInfo.copyrightlink;

            this.set_applet_tooltip(_(imageInfo.copyright.split(", ").join(",\n").replace(" (", "\n(")));
            
            let imgFilename = this.save_path + '/' + wallpaperNameWithExt;
            let imgFile = Gio.file_new_for_path(imgFilename);
            if (imgFile.query_exists(null)) {
                this.on_picture_downloaded(true, imgFilename, true);
            }
            else
            {
                this.download_file("http://www.bing.com"+imageInfo.url, imgFilename, Lang.bind(this, this.on_picture_downloaded));
            }
            
        }
        else {
            global.logError("Bing JSON can't be downloaded, we'll retry in a minute");

            this.updateInProgress = false;
            this.retry_soon();
        }
        return true;
    },

    on_unsplash_json_downloaded: function(success, filename, cached) {
        if (success) {
            global.log("Unsplash JSON successfully downloaded at "+filename);
            let unsplashJson = JSON.parse(Cinnamon.get_file_contents_utf8_sync(filename));

            // If JSON isn't correct, return
            if (unsplashJson["status"] !== undefined) {
                global.logError("Unsplash JSON status is incorrect");
                global.log(Cinnamon.get_file_contents_utf8_sync(filename));
                this.updateInProgress = false;
                return true;
            }

            this.futureWallpaper = unsplashJson.id;
            this.futureWallpaperPage = unsplashJson.links.html + "?" + this.unsplashUtmParam;
            let wallpaperNameWithExt = this.futureWallpaper + ".jpg";

            let description = unsplashJson.description != null ? unsplashJson.description : "[No description]";
            let location = "[No location]";
            if (unsplashJson.location !== undefined && !!unsplashJson.location.title) {
                location = unsplashJson.location.title;
            }
            let credit = "(" + unsplashJson.user.name + " on Unsplash)";
            this.set_applet_tooltip(_([description, location, credit].join("\n")));
            
            let imgFilename = this.save_path + '/' + wallpaperNameWithExt;
            let imgFile = Gio.file_new_for_path(imgFilename);
            if (imgFile.query_exists(null)) {
                global.log("Unsplash image already exist");
                this.on_picture_downloaded(true, imgFilename, true);
            }
            else
            {
                global.log("Downloading Unsplash image...");
                this.download_file(unsplashJson.urls.full, imgFilename, Lang.bind(this, this.on_picture_downloaded));
                this.download_file(unsplashJson.links.download_location + "?" + [this.unsplashUrlTokenParam, this.unsplashUtmParam].join("&"), "/tmp/unsplashDownloadIncrement", Lang.bind(this, function (success, file, cached) {
                    global.log("Incremented Unsplash download counter: " + success);
                }));
            }
            
        }
        else {
            global.log("Unsplash JSON can't be downloaded, we'll retry in a minute");

            this.updateInProgress = false;
            this.retry_soon();
        }
        return true;
    },

    on_picture_downloaded: function(success, file, cached) {
        if (success) {
            global.log("New picture downloaded at " + file);

            // // Highlight
            // let [x, y] = this.get_transformed_position();
            // let [w, h] = this.get_transformed_size();
            // let flashspot = new Flashspot.Flashspot({ x : x, y : y, width: w, height: h });
            // flashspot.fire();

            // Let's change the wallpaper
            let wallpaperSettings = new Gio.Settings({ schema: "org.cinnamon.desktop.background" });
            wallpaperSettings.set_string("picture-uri", "file:///" + file);

            // Save wallpaper data
            this._currentWallpaper = this.futureWallpaper;
            this._currentWallpaperPage = this.futureWallpaperPage;

            // Set timeout
            this.set_next_update();
        }
        else {
            global.log("Image can't be downloaded, we'll retry in a minute");

            // Set retry timeout
            this.retry_soon();
        }

        // Release lock
        this.updateInProgress = false;
    },

    set_next_update: function() {
        // Invalidate existing timeout , if any
        if (this._timeout !== undefined)
        {
            this._clearTimeout(this._timeout);
        }

        // Set new timeout depending on settings
        if (this.source === BING) {
            this._set_next_update_at(DAY);
        }
        else if (this.source === UNSPLASH) {
            this._set_next_update_at(this.period);
        }
    },

    retry_soon: function() {
        // Invalidate existing timeout , if any
        if (this._timeout !== undefined)
        {
            this._clearTimeout(this._timeout);
        }

        this._set_next_update_at(MINUTE);
    },

    _set_next_update_at: function(nextTime) {
        var now = new Date();
        var date;
        if (nextTime == DAY) {
            date = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 0, 0, 1);
        } else if (nextTime == HOUR) {
            date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()+1, 0, 1);
        } else if (nextTime == MINUTE) {
            date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()+1, 1);
        }
        var millisTillNextTime = date - now;
        global.log("Next download at " + date + " i.e. in " + millisTillNextTime + " ms");
        this._timeout = this._setTimeout(() => { this._update(); }, millisTillNextTime);
    },

    _setTimeout: function(func, ms) {
        let args = [];
        // if (arguments.length > 2) {
        //     args = args.slice.call(arguments, 2);
        // }

        let id = Mainloop.timeout_add(ms, () => {
            func.apply(null, args);
            return false; // Stop repeating
        }, null);

        return id;
    },

    _clearTimeout: function(id) {
        Mainloop.source_remove(id);
    },

    on_applet_clicked: function(event) {
        // Do nothing for now
    },

    on_settings_changed: function() {
        global.log("Settings changed");
        this._makeConstants();
        this._update();
    },

    on_period_setting_changed: function() {
        global.log("Period setting changed");
        this.set_next_update();
    },

    go_to_page: function() {
        if (this._currentWallpaperPage !== undefined && this._currentWallpaperPage != null)
        {
            let command = 'xdg-open "'+encodeURI(this._currentWallpaperPage)+'"';
            global.log("Going to :" + command);
            Util.spawnCommandLine(command);
        }
    }
};

function main(metadata, orientation, panel_height, instance_id) {
    return new MyApplet(metadata, orientation, panel_height, instance_id);
}

