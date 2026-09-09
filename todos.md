- /// clean code.

- /// chuyển page nhanh:
  + bấm vào sẽ mở model:
    - cho phép nhập đến page cụ thể
    - hiển thị doanh sách nằm ngang gồm 5 page gần page hiện tại nhất
      + dùng virtual scoll tránh số lượng lớn gây lag
      + nếu số lượng page nhiều thì scroll đến page cuối sẽ show page đầu ví dụ 8 9 10 1 2

- các thao tác với database:
  + backup, restore(cân nhắc giải pháp k dùng pgdump, có thể sử dụng chuẩn riêng k nhất thiết phải export ra .sql, .db. chỉ cần backup và restore đủ dữ liệu, đặc biệt khi kết nối từ xa)
  + export bảng, import bảng(có các option khi conflict thì hủy hay skip), khi import và export đều có preview xem các column đã chuẩn chưa
  + thêm option truncate trong menu context
  + thêm select nhiều table cùng lúc và bấm chuột phải vào sẽ có menu context cho thao tác nhóm

- thêm cá nhân hóa script sql:
  + [x] trong màn hình khi đã kết nối database, bỏ card icon + QueryNet
  + [x] thêm tabs ở trên ô search filter objects (data, scripts)
  + [x] script sql sẽ yêu cầu tạo file để thao tác, sẽ có worktree files theo connection, mỗi connection lưu lại sẽ sinh ra 1 hash, file sẽ lưu vào <appDataDir>/projects/<hash>: ~/Library/Application Support/QueryNest/projects/<hash> ở bản default, <thư mục cạnh binary>/data/projects/<hash> ở bản portable
  + chương trình sẽ phân tích script sql để vạch ra các scope, scope nào gần cursor nhất thì bôi màu nhẹ vào cho user biết là khi bấm run thì script đó sẽ chạy, nếu người dùng bôi đen nhiều script thì sẽ chạy nhiều, khi người dùng chọn bôi đen nhiều scope thì sẽ có 1 minimap bên phải trên hiển thị list script sẽ chạy(để dạng vắn tắt k hiển thị toàn bộ...).
  + thêm completion và hightlight syntax cho mã sql;

- thêm filters, chọn column, đặt limit page

- thêm hiển thị các lệnh sql đang được chạy, thêm tính năng hủy lệnh
