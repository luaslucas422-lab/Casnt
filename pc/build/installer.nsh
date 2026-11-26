; Let the Quest reach Casnt without a Windows Firewall prompt (TCP 47820 + UDP 47821).
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Casnt"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Casnt" dir=in action=allow program="$INSTDIR\Casnt.exe" enable=yes profile=private,domain'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Casnt"'
!macroend
