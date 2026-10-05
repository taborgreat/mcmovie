#!/usr/bin/env python3
# Press keys in the capture display: key.py <display> <keysym> [keysym...]   e.g. key.py :77 F1
import sys, time
from Xlib import display, X, XK
from Xlib.ext import xtest
d = display.Display(sys.argv[1])
for name in sys.argv[2:]:
    code = d.keysym_to_keycode(XK.string_to_keysym(name))
    xtest.fake_input(d, X.KeyPress, code); d.sync(); time.sleep(0.08)
    xtest.fake_input(d, X.KeyRelease, code); d.sync(); time.sleep(0.15)
