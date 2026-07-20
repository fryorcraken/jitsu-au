import { Link } from "@tanstack/react-router";
import { Facebook, Instagram, Youtube, Phone, MessageCircle } from "lucide-react";

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t bg-muted/30">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 md:grid-cols-4">
        <div className="md:col-span-2">
          <div className="flex items-center gap-2 font-display text-lg font-bold text-primary">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground">道</span>
            UTS Jitsu
          </div>
          <p className="mt-3 max-w-sm text-sm text-muted-foreground">
            Practical Japanese Jiu-Jitsu in the heart of Sydney. Beginners welcome. First two sessions are free, all year round.
          </p>
        </div>
        <div>
          <h4 className="text-sm font-semibold">Explore</h4>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li><Link to="/about" className="hover:text-foreground">About</Link></li>
            <li><Link to="/classes" className="hover:text-foreground">Classes</Link></li>
            <li><Link to="/pricing" className="hover:text-foreground">Pricing</Link></li>
            <li><Link to="/faq" className="hover:text-foreground">FAQ</Link></li>
          </ul>
        </div>
        <div>
          <h4 className="text-sm font-semibold">Get in touch</h4>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li><Link to="/register-interest" className="hover:text-foreground">Register interest</Link></li>
            <li><Link to="/waiver" className="hover:text-foreground">Sign waiver</Link></li>
            <li><Link to="/contact" className="hover:text-foreground">Contact us</Link></li>
            <li className="flex items-center gap-2"><Phone className="h-3.5 w-3.5" /> <a href="tel:0493631759" className="hover:text-foreground">0493 631 759</a></li>
            <li className="flex items-center gap-2"><MessageCircle className="h-3.5 w-3.5" /> <a href="https://wa.me/610493631759" className="hover:text-foreground">WhatsApp</a></li>
          </ul>
          <div className="mt-4 flex gap-3 text-muted-foreground">
            <a href="https://www.facebook.com/sydneyjitsu" aria-label="Facebook" className="hover:text-foreground"><Facebook className="h-5 w-5" /></a>
            <a href="https://www.instagram.com/sydneyjitsuinc" aria-label="Instagram" className="hover:text-foreground"><Instagram className="h-5 w-5" /></a>
            <a href="https://www.youtube.com/@sydneyjitsu" aria-label="YouTube" className="hover:text-foreground"><Youtube className="h-5 w-5" /></a>
          </div>
        </div>
      </div>
      <div className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground md:flex-row">
          <p>© {new Date().getFullYear()} Sydney Jitsu Inc. UTS Jitsu. All rights reserved.</p>
          <p>ActivateFit Gym, Harris Street, Ultimo NSW</p>
        </div>
      </div>
    </footer>
  );
}
