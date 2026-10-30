#!/usr/bin/env perl
#MISE description="Adds the SPDX license header to every TypeScript file that has none, or to the files given. Pass --check to list those files instead"
#MISE hide=true
use strict;
use warnings;

my $header = "// SPDX-FileCopyrightText: 2026 Thomas Fazzari\n// SPDX-License-Identifier: MIT\n";
my $check  = @ARGV && $ARGV[0] eq '--check';
shift @ARGV if $check;
my @files = @ARGV ? @ARGV : split /\0/, `git ls-files -z --cached --others --exclude-standard -- '*.ts'`;

my @missing;
for my $file (@files) {
  next unless -f $file;
  open my $in, '<', $file or die "$file: $!\n";
  my $text = do { local $/; <$in> };
  close $in;
  next if $text =~ m{\A(?://.*\n)*// SPDX-License-Identifier: };

  push @missing, $file;
  next if $check;
  open my $out, '>', $file or die "$file: $!\n";
  print $out $header, "\n", $text;
  close $out;
}

if ($check && @missing) {
  print STDERR "These files lack the SPDX license header. Run `mise run fmt` to add it.\n";
  print STDERR "  $_\n" for @missing;
  exit 1;
}
