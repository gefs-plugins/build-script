GEFS Build Script
=================

This is the build script for all of the GEFS extensions.

How to use
----------

First, install the the `gefs-build-script` package (in this directory):

    npm install -g .

Make sure your project has a `gefs-build-config.toml` file in the root
directory.  Defaults (commented out) and possible options are shown below:

    # The name to use for descriptions.
    name = "Example Extension"
    # The variable name through which the extension is accessible.
    globalVariableName = "example_ext"
    # The prefix given to the zip file package.
    shortName = "example"
    # A file called "[name].crx" will be created inside the package.
    crxName = "gefs_example_setup"

    # The license comment to include in the generated .user.js file.
    licenseComment = """
    Copyright (c) Karl Cheng 2016
    Licensed under the GNU General Public Licence, version 3 or later.
    See the LICENSE file for details."""

    [requirejs]
    # The folder containing the modules for the extension. (default)
    # baseUrl = "source"
    # The module name of the main file, relative to baseUrl. (default)
    # name = "main"

Once you have created the file, run the build script (in the root directory of your project):

    gefs-build-script --pem YOUR_PEM_FILE.pem [--debug]

How to contribute
-----------------

If you'd like to contribute to this project, follow the instructions given
in the file `CONTRIBUTING.md`.

License
-------

    Copyright (c) 2016 Karl Cheng  
    Email: <qantas94heavy@gmail.com>

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
