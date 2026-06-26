# やりたいこと
'/Users/kurokzhr/.hermes/ruku_data/cnp-times'
と同じような形で、
https://docs.google.com/spreadsheets/d/1bjBz634jh4xIALM8nJ6G9V9MINWincIdYSUYa3w8qHo/edit?gid=967015809#gid=967015809
や
https://docs.google.com/spreadsheets/d/1bjBz634jh4xIALM8nJ6G9V9MINWincIdYSUYa3w8qHo/edit?gid=428079422#gid=428079422
のデータをWebに掲載したい。

クラシック版として、
HTML1シートの24時間出来高順
HTML2シートのメンバー数増順
が見れるようにしたい。
現在は30位までだが、30位まで版と、全PJ版があっても良い

高機能版としては、
各PJごとの価格や売上高、メンバー数、トークン在庫など、見れるデータの推移は全て見えるようにしたい。

上記のシートは、2026年のデータとなっているが、
過去のデータは
https://drive.google.com/drive/folders/1-aK0FgZ6xkl6ajjxOwN0WXDaHENg1LK9
にあるため、２０２４までは遡ってデータを結合して欲しい。

また、データ収集スクリプトは、
'/Users/kurokzhr/Library/CloudStorage/GoogleDrive-ruku.practice@gmail.c
om/マイドライブ/00_XXX_TIMES/00_CreateAutoTimes/100_FiNANCiE'
ここにあり、
'/Users/kurokzhr/Library/CloudStorage/GoogleDrive-ruku.practice@gm
ail.com/マイドライブ/00_XXX_TIMES/00_CreateAutoTimes/admin_auto_action.py'
このスクリプトによって、毎時間定期的に自動実行してデータ更新を見ている。FiNANCiEに関する自動実行スクリプトは、GitHubに移植したい。

まずは、既存のスプレッドシートやPythonスクリプトを見て、やっていることの内容を把握して欲しい。

作業フォルダは、
/Users/kurokzhr/.hermes/ruku_data/FiNANCiE-times-web/
で実施すること。今のスクリプトをいじるときも、このフォルダにコピーして実行することとし、元のスクリプトは触らないこと。